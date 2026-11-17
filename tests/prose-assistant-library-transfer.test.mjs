import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createProseAssistantLibraryTransfer} from '../qianmu-prose-assistant-library-transfer.js';
import {openProseAssistantConversations} from '../qianmu-prose-assistant-conversations.js';
import {createProseAssistantThreadKey} from '../qianmu-prose-assistant-history-contract.js';
import {createProseAssistantFloorTools} from '../qianmu-prose-assistant-floor.js';
import {createProseFloorTools} from '../qianmu-prose-floor-tools.js';
import {emptyProseAssistantHistory} from '../qianmu-prose-assistant-history-contract.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const raw='st-user:assistant-library-fixture',accountOf=namespace=>'st-user:'+hash(namespace.slice(8)),account=accountOf(raw);
const base=(name='A',owner=account)=>JSON.stringify(['qianmu-prose-assistant-v2',owner,`char:${name}.png`,{kind:'character',chatId:`Chat ${name}`,avatar:`${name}.png`},null]);
const offstage=JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]);
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const history=(key,text,revision=1)=>({version:1,namespace:key,revision,updatedAt:20+revision,rows:[{id:1,user:'问 '+text,assistant:'答 '+text,status:'complete',reference:null}]});

// The real native-file store over an in-memory transport: one "device" per fixture.
function device(namespace=raw){
 const transport=streamCheckpointTransport(namespace),f={transport,namespace,live:true,notices:[],downloads:[],confirmations:[],approve:true,now:1000};
 const storageFactory=options=>transport.createStorage(options),owner=accountOf(namespace);
 f.transfer=createProseAssistantLibraryTransfer({resolveNamespace:async()=>f.namespace,isCurrent:()=>f.live,storageFactory,now:()=>f.now,
  download:async(blob,name)=>{f.downloads.push({blob,name});},confirm:async(title,text)=>{f.confirmations.push([title,text]);return f.approve;},notify:(message,type)=>f.notices.push([message,type])});
 f.catalogue=()=>openProseAssistantConversations({source:{key:JSON.stringify(['qianmu-prose-assistant-offstage-v1',owner]),scope:{namespace:owner},assertCurrent:()=>true,guard:async()=>true},isCurrent:()=>true,storageFactory,now:()=>f.now});
 f.put=async(key,value)=>{const store=await transport.createStorage({maxBytes:4*1024*1024+2048});await store.write('assistant-'+hash(key),value,{expectedFingerprint:null});store.close();};
 f.remote=key=>{const slot='assistant-'+hash(key),head=[...transport.files.values()].map(JSON.parse).find(body=>body.schema==='qianmu.st-account-head.v1'&&body.slot===slot);return head?JSON.parse(transport.files.get(`qianmu-v2-${head.scope}-${slot}-${head.fingerprint}.json`)).value:null;};
 f.index=()=>[...transport.files.values()].map(JSON.parse).find(body=>body.schema==='qianmu.st-account-snapshot.v1'&&body.slot==='assistant-conversations')?.value;
 f.uploads=()=>transport.calls.filter(call=>call.path==='/api/files/upload').length;
 return f;
}
async function library(){
 const f=device(),catalogue=await f.catalogue(),thread=createProseAssistantThreadKey(base(),id(1)),blank=createProseAssistantThreadKey(base(),id(2)),removed=createProseAssistantThreadKey(base(),id(3));
 await catalogue.ensure({key:base(),title:'角色 A',updatedAt:21});await catalogue.create({ownerKey:base(),title:'角色 A',id:id(1)});await catalogue.create({ownerKey:base(),title:'角色 A',id:id(2)});await catalogue.create({ownerKey:base(),title:'角色 A',id:id(3)});
 await catalogue.rename(thread,'水墨笔记');await catalogue.archive([thread]);await catalogue.delete([removed]);await catalogue.activate(base(),{defaultForCurrent:base()});catalogue.close();
 await f.put(base(),history(base(),'A'));await f.put(thread,history(thread,'归档'));await f.put(removed,history(removed,'已删'));
 const calls=f.transport.calls.length,result=await f.transfer.exportLibrary();assert.deepEqual(result,{status:'exported',exported:2});
 assert.equal(f.uploads(),f.transport.calls.slice(0,calls).filter(call=>call.path==='/api/files/upload').length,'export uploads nothing');
 return {f,thread,blank,removed,blob:f.downloads[0].blob,payload:JSON.parse(await f.downloads[0].blob.text())};
}

test('export gathers every listed conversation with messages into one account-bound file, archived included',async()=>{
 const {f,thread,blank,removed,payload}=await library();
 assert.match(f.downloads[0].name,/^qianmu-assistant-library-\d{8}-\d{6}\.json$/);assert.equal(f.downloads[0].blob.type,'application/json');assert.deepEqual(f.notices,[['已导出 2 个特助对话。','success']]);
 assert.deepEqual(Object.keys(payload),['type','version','exportedAt','account','index','histories']);assert.equal(payload.type,'qianmu-assistant-library');assert.equal(payload.version,1);assert.equal(payload.account,account);assert.equal(payload.exportedAt,new Date(1000).toISOString());
 assert.deepEqual(payload.index.entries.map(entry=>entry.key),[base(),thread],'empty and deleted conversations are not exported');assert.ok(![blank,removed].some(key=>JSON.stringify(payload).includes(JSON.stringify(key).slice(1,-1))));
 const archived=payload.index.entries[1];assert.equal(archived.archived,true);assert.equal(archived.title,'水墨笔记');assert.equal(archived.titleSource,'manual');assert.deepEqual(payload.index.defaults,[{ownerKey:base(),key:base()}]);
 assert.deepEqual(payload.histories,[{key:base(),history:history(base(),'A')},{key:thread,history:history(thread,'归档')}]);
 assert.doesNotMatch(JSON.stringify(payload),/assistant-library-fixture/,'the raw account handle is not written into the file');
});

test('an empty library exports nothing and says so',async()=>{
 const f=device(),catalogue=await f.catalogue();await catalogue.create({ownerKey:offstage,title:'独立对话',id:id(1)});catalogue.close();
 assert.deepEqual(await f.transfer.exportLibrary(),{status:'empty',exported:0});assert.deepEqual(f.downloads,[]);assert.deepEqual(f.notices,[['没有可导出的特助对话。','info']]);
});

test('import writes absent conversations with their metadata, skips what the account already has and never overwrites',async()=>{
 const {thread,blob,payload}=await library(),f=device(),catalogue=await f.catalogue();
 await catalogue.ensure({key:base(),title:'本机已有',updatedAt:5});catalogue.close();await f.put(base(),history(base(),'本机版本',3));
 const before=f.uploads(),result=await f.transfer.importLibrary(blob);
 assert.deepEqual(result,{status:'imported',imported:1,skipped:1});assert.deepEqual(f.confirmations,[['导入场外特助','将导入 1 个对话，已有的不覆盖。是否继续？']]);assert.deepEqual(f.notices,[['已导入 1 个特助对话，1 个已存在。','success']]);
 assert.deepEqual(f.remote(base()),history(base(),'本机版本',3),'an existing conversation keeps its own messages');assert.deepEqual(f.remote(thread),history(thread,'归档'));
 const index=f.index(),own=index.entries.find(entry=>entry.key===base()),added=index.entries.find(entry=>entry.key===thread);assert.equal(index.entries.length,2);assert.equal(own.title,'本机已有');
 assert.deepEqual(added,payload.index.entries[1]);assert.equal(index.version,3);assert.deepEqual(index.defaults,[{ownerKey:base(),key:base()}]);
 assert.equal(f.uploads(),before+3,'one history body, its head and one directory snapshot');
 const again=f.uploads();assert.deepEqual(await f.transfer.importLibrary(blob),{status:'imported',imported:0,skipped:2});assert.equal(f.confirmations.length,1,'nothing to write asks nothing');
 assert.deepEqual(f.notices.at(-1),['已导入 0 个特助对话，2 个已存在。','info']);assert.equal(f.uploads(),again);
});

test('tombstones stay removed, a declined confirmation writes nothing and an interrupted import is completed without rewriting',async()=>{
 const {thread,blob}=await library(),f=device(),catalogue=await f.catalogue();
 await catalogue.create({ownerKey:base(),title:'角色 A',id:id(1)});await catalogue.delete([thread]);catalogue.close();
 f.approve=false;const before=f.uploads();assert.deepEqual(await f.transfer.importLibrary(blob),{status:'cancelled',imported:0,skipped:0});assert.equal(f.uploads(),before);assert.equal(f.remote(base()),null);assert.deepEqual(f.notices,[]);
 f.approve=true;assert.deepEqual(await f.transfer.importLibrary(blob),{status:'imported',imported:1,skipped:1});
 assert.equal(f.remote(thread),null,'a deleted conversation is not written back');assert.equal(f.index().entries.find(entry=>entry.key===thread).deleted,true);assert.deepEqual(f.remote(base()),history(base(),'A'));
 assert.deepEqual(f.index().defaults,[{ownerKey:base(),key:base()}]);
 const g=device();await g.put(base(),history(base(),'A'));await g.put(thread,history(thread,'另一份内容',2));const uploads=g.uploads();
 assert.deepEqual(await g.transfer.importLibrary(blob),{status:'imported',imported:1,skipped:1});assert.equal(g.uploads(),uploads+1,'only the directory is written');
 assert.deepEqual(g.index().entries.map(entry=>entry.key),[base()]);assert.deepEqual(g.remote(thread),history(thread,'另一份内容',2),'an unlisted different document is left alone');
});

test('a backup from another account, a foreign file or a tampered one is refused before anything is written',async()=>{
 const {blob,payload}=await library(),other=device('st-user:someone-else');
 await assert.rejects(other.transfer.importLibrary(blob),{message:'这份备份属于其他账户，未导入。'});assert.equal(other.uploads(),0);assert.deepEqual(other.confirmations,[]);
 const f=device(),file=value=>new Blob([typeof value==='string'?value:JSON.stringify(value)]),clone=()=>structuredClone(payload);
 const cases=[['{',/无法读取/],[{...clone(),type:'qianmu-assistant-conversation-backup'},/不是场外特助的整库备份/],[{...clone(),version:2},/不是场外特助的整库备份/],[{...clone(),extra:1},/不完整/],
  [(()=>{const value=clone();value.histories.pop();return value;})(),/不完整/],[(()=>{const value=clone();value.histories.reverse();return value;})(),/不完整/],
  [(()=>{const value=clone();value.histories[0].history.namespace=value.histories[1].key;return value;})(),/不完整/],[(()=>{const value=clone();value.histories[0].history.rows[0].status='running';return value;})(),/不完整/],
  [(()=>{const value=clone();value.index.entries[0].deleted=true;return value;})(),/不完整/],[(()=>{const value=clone();value.index.entries[1].archived='yes';return value;})(),/不完整/],
  [(()=>{const value=clone();value.index.entries[0].title='';return value;})(),/不完整/],[(()=>{const value=clone();value.index.defaults.push({ownerKey:base(),key:value.index.entries[1].key});return value;})(),/不完整/]];
 for(const [value,message] of cases)await assert.rejects(f.transfer.importLibrary(file(value)),{message,code:'prose_assistant_library'});
 await assert.rejects(f.transfer.importLibrary({size:64*1024*1024+1,text:async()=>assert.fail('an oversized file is not read')}),/过大/);await assert.rejects(f.transfer.importLibrary(null),/请选择备份文件/);
 assert.equal(f.uploads(),0);assert.deepEqual(f.confirmations,[]);assert.deepEqual(f.notices,[]);
});

test('an account change during import stops before the directory is touched',async()=>{
 const {blob}=await library(),f=device();f.transfer=createProseAssistantLibraryTransfer({resolveNamespace:async()=>f.namespace,isCurrent:()=>f.live,storageFactory:options=>f.transport.createStorage(options),
  download:async()=>{},confirm:async()=>{f.live=false;return true;},notify:(...args)=>f.notices.push(args)});
 await assert.rejects(f.transfer.importLibrary(blob));assert.equal(f.uploads(),0);assert.deepEqual(f.notices,[]);
});

test('host entry points report their own failures, refuse while the assistant window is open and reach the configured ST files',async t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('no external request'));
 const {blob}=await library(),f=device(),dom=proseAssistantPanelDom(),host={chat:[],chatMetadata:{}},notices=[],downloads=[],confirmations=[];f.transport.configure();
 const tools=createProseAssistantFloorTools({getContext:()=>host,resolveNamespace:async()=>raw,headers:()=>({}),isCurrent:()=>true,notify:(...args)=>notices.push(args),download:(file,name)=>downloads.push([file,name]),
  confirm:async(...args)=>{confirmations.push(args);return true;},assistantHistoryFactory:async({source})=>({initialHistory:()=>emptyProseAssistantHistory(source.key),close(){}})});
 try{
  const input={disabled:false,isConnected:true};
  assert.deepEqual(await tools.importAssistantLibrary(new Blob(['{"type":"other"}']),input),{status:'failed'});assert.deepEqual(notices,[['场外特助导入未完成：这不是场外特助的整库备份，未导入。','warning']]);assert.equal(input.disabled,false);
  assert.deepEqual(await tools.importAssistantLibrary(blob,input),{status:'imported',imported:2,skipped:0});assert.deepEqual(confirmations,[['导入场外特助','将导入 2 个对话，已有的不覆盖。是否继续？']]);assert.equal(f.index().entries.length,2);
  const button={disabled:false,isConnected:true},pending=tools.exportAssistantLibrary(button);assert.equal(button.disabled,true);
  assert.deepEqual(await tools.exportAssistantLibrary(button),{status:'cancelled'},'a second press while running does nothing');
  assert.deepEqual(await tools.importAssistantLibrary(blob),{status:'cancelled'});assert.deepEqual(notices.at(-1),['请先关闭场外特助或结束清理。','warning']);
  assert.deepEqual(await pending,{status:'exported',exported:2});assert.equal(button.disabled,false);assert.match(downloads[0][1],/^qianmu-assistant-library-/);
  tools.bindRoot(dom.parent);const panel=await tools.openAssistant();assert.ok(panel);await panel.ready;const count=downloads.length;
  assert.deepEqual(await tools.exportAssistantLibrary(),{status:'cancelled'});assert.deepEqual(notices.at(-1),['请先关闭场外特助或结束清理。','warning']);assert.equal(downloads.length,count);
  panel.dispose();await panel.finished;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await tools.exportAssistantLibrary(),{status:'exported',exported:2});
 }finally{tools.disposeFloor();}
 const wrapper=createProseFloorTools({getContext:()=>host,resolveNamespace:async()=>raw,headers:()=>({}),isCurrent:()=>true,notify(){},download(){},confirm:async()=>true});
 assert.equal(typeof wrapper.exportAssistantLibrary,'function');assert.equal(typeof wrapper.importAssistantLibrary,'function');wrapper.dispose();
});
