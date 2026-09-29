import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {openProseAssistantPanel} from '../qianmu-prose-assistant-panel.js';
import {openNativeProseAssistantHistory} from '../qianmu-prose-assistant-native.js';
import {openProseAssistantConversations,PROSE_ASSISTANT_CONVERSATIONS_LIMITS} from '../qianmu-prose-assistant-conversations.js';
import {captureProseAssistantChatSource} from '../qianmu-prose-assistant-source.js';
import {emptyProseAssistantHistory,createProseAssistantThreadKey} from '../qianmu-prose-assistant-history-contract.js';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const hostFor=(name='A')=>({chatId:`Chat ${name}`,characterId:0,characters:[{avatar:`${name}.png`,name:`角色 ${name}`,chat:`Chat ${name}`}],chatMetadata:{},eventSource:new EventEmitter(),chat:[{mes:`${name} earlier prose`},{mes:`${name} latest prose`}]});
const row=(user='旧问题',assistant='旧回答')=>({id:1,user,assistant,status:'complete',reference:null});
const uploaded=call=>call.path==='/api/files/upload'?JSON.parse(Buffer.from(JSON.parse(call.options.body).data,'base64').toString('utf8')):null;

async function fixture(t,{initialRows=[]}={}){
 const namespace='st-user:conversation-panel-fixture',transport=streamCheckpointTransport(namespace),dom=proseAssistantPanelDom();
 const f={namespace,transport,dom,host:hostFor(),epoch:0,live:true,panel:null,models:[],proseReads:[],confirmations:[],copies:[],mode:'json',confirmApproval:true};
 const source=host=>({getContext:()=>host||f.host,epoch:()=>f.epoch,resolveNamespace:async()=>f.namespace,isCurrent:()=>f.live,
  readText:(message,floor)=>{f.proseReads.push(floor);return message.mes;}});
 f.capture=async host=>captureProseAssistantChatSource(source(host));
 f.seed=async(host,rows=[])=>{
  const captured=await f.capture(host),key=captured.key;captured.close();const store=await transport.createStorage({maxBytes:4*1024*1024+2048});
  const value=rows.length?{version:1,namespace:key,revision:1,updatedAt:20,rows}:emptyProseAssistantHistory(key);
  await store.write('assistant-'+hash(key),value,{expectedFingerprint:null});store.close();return key;
 };
 f.base=await f.seed(f.host,initialRows);transport.calls.length=0;transport.configure();
 t.mock.method(globalThis,'fetch',()=>assert.fail('unexpected external request'));
 const request=async(url,options)=>{
  assert.equal(url,'/api/backends/chat-completions/generate');assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');
  assert.equal(options.headers['X-CSRF-Token'],'synthetic');const body=JSON.parse(options.body);f.models.push(body);
  assert.equal(body.custom_url,'https://assistant.fixture.invalid/v1');assert.equal(body.custom_include_headers,'Authorization: Bearer synthetic-key');
  if(f.mode==='hold')return new Response(new ReadableStream({start(controller){
   f.appendReply=(text,finished=false)=>{controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta:{content:text},...(finished?{finish_reason:'stop'}:{})}]})}\n\n`));if(finished)controller.close();};
   f.finishReply=()=>f.appendReply('，已完成',true);f.appendReply('部分回答');
  }}),{headers:{'content-type':'text/event-stream'}});
  return Response.json({choices:[{message:{content:'回答 '+f.models.length},finish_reason:'stop'}]});
 };
 f.action=name=>dom.all().find(node=>node.dataset.paAction===name);
 f.listAction=name=>dom.all().find(node=>node.dataset.paListAction===name);
 f.question=()=>dom.get('向场外特助提问');
 f.rows=()=>dom.all().filter(node=>Object.hasOwn(node.dataset,'paTurn'));
 f.listRows=()=>dom.all().filter(node=>Object.hasOwn(node.dataset,'paConversationKey'));
 f.status=()=>dom.all().find(node=>Object.hasOwn(node.dataset,'paStatus'))?.textContent||'';
 f.notice=()=>dom.all().find(node=>Object.hasOwn(node.dataset,'paHistory'))?.textContent||'';
 f.idle=()=>dom.wait(()=>f.panel.element.getAttribute('aria-busy')==='false','panel did not finish: '+f.notice()+' '+f.status());
 f.catalogue=()=>[...transport.files.values()].map(JSON.parse).find(body=>body.schema==='qianmu.st-account-snapshot.v1'&&body.slot==='assistant-conversations')?.value;
 f.remote=key=>{const slot='assistant-'+hash(key),head=[...transport.files.values()].map(JSON.parse).find(body=>body.schema==='qianmu.st-account-head.v1'&&body.slot===slot);return head?JSON.parse(transport.files.get(`qianmu-v2-${head.scope}-${slot}-${head.fingerprint}.json`)).value:null;};
 f.open=async()=>{
  f.panel=await openProseAssistantPanel({parent:dom.parent,source:source(),profiles:[{id:'fixture',name:'Fixture',apiUrl:'https://assistant.fixture.invalid/v1',apiKey:'synthetic-key',model:'synthetic-model'}],selection:{mode:'profile',profileId:'fixture'},referenceFloors:2,
   getProfileStream:()=>f.mode==='hold',getRequestHeaders:()=>({'X-CSRF-Token':'synthetic'}),fetchImpl:request,copy:async text=>{f.copies.push(text);},confirm:async text=>{f.confirmations.push(text);return f.confirmApproval;},isCurrent:()=>f.live,
   historyFactory:openNativeProseAssistantHistory,conversationFactory:openProseAssistantConversations,retainOnClose:true});
  await f.panel.ready;await f.idle();assert.equal(f.notice(),'','initial history should be readable');return f.panel;
 };
 f.send=async text=>{const before=f.models.length;f.question().value=text;f.question().emit('input');assert.equal(f.action('send').disabled,false);f.action('send').click();await dom.wait(()=>f.models.length===before+1,'model not reached: '+f.status());await f.idle();};
 f.showList=()=>{f.action('conversations').click();assert.equal(dom.get('最近特助对话').hidden,false);};
 f.choose=async key=>{f.showList();const entry=f.listRows().find(node=>node.dataset.paConversationKey===key);assert.ok(entry);entry.click();await dom.wait(()=>dom.get('最近特助对话').hidden);await f.idle();};
 f.create=async()=>{f.showList();const before=f.catalogue()?.defaults.find(item=>item.ownerKey===f.base)?.key;f.listAction('new').click();await dom.wait(()=>{const key=f.catalogue()?.defaults.find(item=>item.ownerKey===f.base)?.key;return key&&key!==before;});await f.idle();return f.catalogue().defaults.find(item=>item.ownerKey===f.base).key;};
 f.close=async()=>{f.action('close').click();await dom.wait(()=>!f.panel.visible);};
 f.cold=async()=>{f.panel.dispose();await f.panel.finished;return f.open();};
 t.after(()=>{f.panel?.dispose();f.live=false;});await f.open();return f;
}

test('real panel new conversation keeps prior native messages, remembers the selected default, and reads lists from metadata only',async t=>{
 const f=await fixture(t);await f.send('旧默认会话');const old=structuredClone(f.remote(f.base)),thread=await f.create();
 assert.notEqual(thread,f.base);assert.equal(f.rows().length,0);assert.deepEqual(f.remote(f.base),old);
 await f.send('新会话问题');assert.equal(f.remote(thread).rows[0].user,'新会话问题');assert.deepEqual(f.remote(f.base),old);
 const calls=f.transport.calls.length;f.showList();assert.equal(f.listRows().length,2);
 const search=f.dom.get('搜索特助对话');search.value='no match';search.emit('input');assert.equal(f.listRows().length,0);search.value='角色 A';search.emit('input');assert.equal(f.listRows().length,2);
 assert.equal(f.transport.calls.length,calls,'list open and search read no directory or history files');
 f.listRows().find(node=>node.dataset.paConversationKey===thread).click();await f.idle();assert.equal(f.transport.calls.length,calls,'selecting the current conversation does not reopen its history');
 await f.cold();assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'新会话问题');
 await f.choose(f.base);assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'旧默认会话');assert.equal(f.catalogue().defaults.find(entry=>entry.ownerKey===f.base).key,f.base);
 await f.cold();assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'旧默认会话');assert.equal(f.models.length,2);
});

test('foreign selected conversation sends zero current-chat prose and persists only into its selected thread',async t=>{
 const f=await fixture(t);await f.send('A original');const aBefore=structuredClone(f.remote(f.base));
 const hostB=hostFor('B'),bBase=await f.seed(hostB),sourceB=await f.capture(hostB),catalogue=await openProseAssistantConversations({source:sourceB,isCurrent:()=>f.live});
 const b=await catalogue.create({ownerKey:bBase,title:'角色 B',id:'00000000-0000-4000-8000-000000000002'});catalogue.close();sourceB.close();
 f.showList();f.listAction('refresh').click();await f.idle();await f.choose(b.key);assert.equal(f.dom.get('参考楼层数').value,'0');assert.equal(f.dom.get('参考楼层数').disabled,true);
 f.proseReads.length=0;await f.send('B foreign followup');assert.deepEqual(f.proseReads,[]);
 const payload=JSON.parse(f.models.at(-1).messages.at(-1).content);assert.equal(payload.reference,null);assert.deepEqual(payload.previous,[]);assert.doesNotMatch(JSON.stringify(payload),/A earlier prose|A latest prose/);
 assert.equal(f.remote(b.key).rows[0].user,'B foreign followup');assert.equal(f.remote(b.key).rows[0].reference,null);assert.deepEqual(f.remote(f.base),aBefore);
 assert.equal(f.catalogue().defaults.find(entry=>entry.ownerKey===f.base).key,f.base,'opening a foreign thread does not rebind the current chat default');
});

test('legacy history opens and lists without writes, then new conversation remembers both entries in one user-action write',async t=>{
 const f=await fixture(t,{initialRows:[row()]}),original=structuredClone(f.remote(f.base));
 assert.equal(f.rows().length,1);assert.equal(f.catalogue(),undefined);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,0);
 const calls=f.transport.calls.length;f.showList();assert.equal(f.listRows().length,1);assert.equal(f.listRows()[0].dataset.paConversationKey,f.base);f.listRows()[0].click();assert.equal(f.transport.calls.length,calls);
 const thread=await f.create();assert.equal(f.catalogue().entries.length,2);assert.equal(f.catalogue().entries[0].key,f.base);assert.notEqual(thread,f.base);
 assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,1);assert.deepEqual(f.remote(f.base),original);assert.equal(f.rows().length,0);
 await f.choose(f.base);assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'旧问题');assert.equal(f.models.length,0);
});

test('deleting an unregistered visible legacy conversation creates its tombstone in the same write and never revives it',async t=>{
 const f=await fixture(t,{initialRows:[row()]}),original=structuredClone(f.remote(f.base));f.showList();f.listAction('select').click();f.listAction('select').click();f.listAction('delete').click();
 await f.dom.wait(()=>f.catalogue()?.entries[0]?.deleted);await f.idle();assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,1);assert.equal(f.catalogue().entries[0].key,f.base);assert.equal(f.rows().length,0);
 await f.cold();f.showList();assert.equal(f.listRows().length,0);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,1);assert.deepEqual(f.remote(f.base),original);assert.equal(f.models.length,0);
});

test('a pre-write remember failure cannot continue a switch through a no-target retry',async t=>{
 const f=await fixture(t,{initialRows:[row()]}),hostB=hostFor('B'),source=await f.capture(hostB),catalogue=await openProseAssistantConversations({source,isCurrent:()=>f.live});
 const target=await catalogue.create({ownerKey:source.key,title:'B',id:'00000000-0000-4000-8000-000000000002'});catalogue.close();source.close();
 const [filename,text]=[...f.transport.files].find(([name])=>name.endsWith('-assistant-conversations.snapshot.json')),full=JSON.parse(text);
 for(let n=full.value.entries.length;n<PROSE_ASSISTANT_CONVERSATIONS_LIMITS.entries;n++)full.value.entries.push({...target,key:createProseAssistantThreadKey(target.ownerKey,`00000000-0000-4000-8000-${String(n+100).padStart(12,'0')}`),deleted:true});
 f.transport.files.set(filename,JSON.stringify(full));f.showList();f.listAction('refresh').click();await f.idle();
 const posts=f.transport.calls.filter(call=>call.options.method==='POST').length;
 f.listRows().find(node=>node.dataset.paConversationKey===target.key).click();await f.dom.wait(()=>!!f.status());await f.idle();
 assert.equal(f.action('retry-conversations').hidden,true);assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'旧问题');assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,posts);assert.equal(f.catalogue().entries.length,PROSE_ASSISTANT_CONVERSATIONS_LIMITS.entries);assert.match(f.status(),/已满/);
 f.action('retry-conversations').click();await f.idle();assert.equal(f.dom.get('最近特助对话').hidden,false);assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'旧问题');
 assert.equal(f.listAction('refresh').disabled,false);assert.equal(f.listAction('new').disabled,false,'the unsubmitted action does not lock the panel into a false recovery');
});

test('editing a legacy reply registers only on save, retains its draft after a lost receipt, and retries without model replay',async t=>{
 const f=await fixture(t,{initialRows:[row()]}),original=structuredClone(f.remote(f.base));f.rows()[0].querySelector('[data-pa-action="edit"]').click();
 const editor=f.dom.get('编辑助手回复');editor.value='修改后的旧回复';assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,0);
 let lost=false;f.transport.hook=({path,options,files,json})=>{if(!lost&&uploaded({path,options})?.slot==='assistant-conversations'){lost=true;const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return json({},503);}};
 f.action('save-reply').click();await f.dom.wait(()=>lost);await f.idle();assert.equal(f.dom.get('编辑助手回复'),editor);assert.equal(editor.value,'修改后的旧回复');assert.deepEqual(f.remote(f.base),original);assert.equal(f.action('retry-conversations').hidden,false);
 const posts=f.transport.calls.filter(call=>call.options.method==='POST').length;f.transport.hook=null;f.action('retry-conversations').click();await f.idle();assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,posts);assert.equal(f.dom.get('编辑助手回复'),editor);
 f.action('save-reply').click();await f.dom.wait(()=>f.remote(f.base).rows[0].assistant==='修改后的旧回复');await f.idle();assert.equal(f.rows()[0].querySelector('.qm-pa-reply').textContent,'修改后的旧回复');assert.equal(f.models.length,0);assert.equal(f.notice(),'');assert.equal(f.status(),'');
});

test('editing a legacy question retains its original editor until directory confirmation permits model submission',async t=>{
 const f=await fixture(t,{initialRows:[row()]}),original=structuredClone(f.remote(f.base));f.rows()[0].querySelector('[data-pa-action="edit-question"]').click();
 const editor=f.dom.get('编辑提问');editor.value='修改后的旧问题';let failures=0;
 f.transport.hook=({path,options,json})=>{if(uploaded({path,options})?.slot==='assistant-conversations'){failures++;return json({},503);}};
 f.action('save-reply').click();await f.dom.wait(()=>failures===1);await f.idle();assert.equal(f.models.length,0);assert.equal(f.dom.get('编辑提问'),editor);assert.equal(editor.value,'修改后的旧问题');assert.deepEqual(f.remote(f.base),original);
 f.transport.hook=null;f.action('retry-conversations').click();await f.idle();assert.equal(f.dom.get('编辑提问'),editor);assert.equal(f.models.length,0);
 f.action('save-reply').click();await f.dom.wait(()=>f.models.length===1);await f.idle();assert.equal(f.remote(f.base).rows.length,1);assert.equal(f.remote(f.base).rows[0].user,'修改后的旧问题');assert.equal(f.remote(f.base).rows[0].assistant,'回答 1');
});

test('multi-select deletion is one directory tombstone update and does not delete ST files or rediscover legacy messages',async t=>{
 const f=await fixture(t);await f.send('删除前原会话');const thread=await f.create();await f.send('删除前新会话');
 const histories=new Map([...f.transport.files].filter(([name])=>!name.endsWith('-assistant-conversations.snapshot.json'))),beforePosts=f.transport.calls.filter(call=>call.options.method==='POST').length;
 f.showList();f.listAction('select').click();f.listAction('select').click();assert.equal(f.listAction('delete').hidden,false);f.listAction('delete').click();
 await f.dom.wait(()=>f.catalogue().entries.every(entry=>entry.deleted));await f.idle();assert.equal(f.rows().length,0);assert.equal(f.listRows().length,0);assert.equal(f.listAction('delete').hidden,true);
 assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,beforePosts+1,'batch deletion writes only one catalog');
 assert.deepEqual(new Map([...f.transport.files].filter(([name])=>!name.endsWith('-assistant-conversations.snapshot.json'))),histories);
 assert.match(f.confirmations.at(-1),/历史版本仍保留/);assert.ok(f.catalogue().entries.some(entry=>entry.key===thread&&entry.deleted));
 await f.cold();assert.equal(f.rows().length,0);assert.equal(f.models.length,2);f.showList();assert.equal(f.listRows().length,0,'deleted legacy default must not reappear on cold open');
 assert.deepEqual(new Map([...f.transport.files].filter(([name])=>!name.endsWith('-assistant-conversations.snapshot.json'))),histories);
});

test('catalog registration failure blocks model submission, keeps the question and retries only the directory',async t=>{
 const f=await fixture(t);let failures=0;f.transport.hook=({path,options,json})=>{if(uploaded({path,options})?.slot==='assistant-conversations'){failures++;return json({},503);}};
 f.question().value='不能提前发送';f.question().emit('input');f.action('send').click();await f.dom.wait(()=>failures===1);await f.idle();
 assert.equal(f.models.length,0);assert.equal(f.question().value,'不能提前发送');assert.equal(f.action('retry-conversations').hidden,false);assert.equal(f.action('send').disabled,true);
 f.transport.hook=null;f.action('retry-conversations').click();await f.idle();assert.equal(f.models.length,0);assert.equal(f.question().value,'不能提前发送');assert.equal(f.catalogue().entries.length,1);
 await f.send('不能提前发送');assert.equal(f.models.length,1);assert.equal(f.remote(f.base).rows[0].user,'不能提前发送');
});

test('catalog metadata failure after a confirmed answer retries without resending model or native messages',async t=>{
 const f=await fixture(t);let cataloguePosts=0;f.transport.hook=({path,options,json})=>{if(uploaded({path,options})?.slot==='assistant-conversations'&&++cataloguePosts===2)return json({},503);};
 await f.send('已经得到回答');assert.equal(f.models.length,1);assert.equal(f.remote(f.base).rows[0].assistant,'回答 1');assert.match(f.status(),/对话已保存，列表更新未确认/);
 assert.equal(f.action('retry-conversations').hidden,false);const before=f.transport.calls.length,history=structuredClone(f.remote(f.base));
 f.transport.hook=null;f.action('retry-conversations').click();await f.idle();assert.equal(f.models.length,1);assert.deepEqual(f.remote(f.base),history);assert.equal(f.status(),'');
 assert.ok(f.transport.calls.slice(before).every(call=>call.path.endsWith('-assistant-conversations.snapshot.json')||uploaded(call)?.slot==='assistant-conversations'));
});

test('new conversation lost directory receipt is reconciled to the same entry without duplicate create',async t=>{
 const f=await fixture(t,{initialRows:[row()]}),original=structuredClone(f.remote(f.base));let lost=false;f.transport.hook=({path,options,files,json})=>{
  if(!lost&&uploaded({path,options})?.slot==='assistant-conversations'){lost=true;const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return json({},503);}
 };
 f.showList();f.listAction('new').click();await f.dom.wait(()=>lost);await f.idle();const key=f.catalogue().defaults.find(entry=>entry.ownerKey===f.base).key;
 assert.equal(f.catalogue().entries.length,2);assert.equal(f.action('retry-conversations').hidden,false);const writes=f.transport.calls.filter(call=>call.options.method==='POST').length;
 f.transport.hook=null;f.action('retry-conversations').click();await f.idle();assert.equal(f.catalogue().entries.length,2);assert.equal(f.catalogue().defaults.find(entry=>entry.ownerKey===f.base).key,key);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,writes);assert.deepEqual(f.remote(f.base),original);assert.equal(f.rows().length,0);
 assert.equal(f.models.length,0);await f.send('恢复后第一问');assert.equal(f.remote(key).rows[0].user,'恢复后第一问');
});

test('catalog conflict cannot overwrite a newer directory and explicit list refresh remains reachable',async t=>{
 const f=await fixture(t);await f.send('现有对话');const foreign=await f.capture(),other=await openProseAssistantConversations({source:foreign,isCurrent:()=>f.live});
 await other.create({ownerKey:f.base,title:'另一页面新增',id:'00000000-0000-4000-8000-000000000003'});other.close();foreign.close();
 f.showList();f.listAction('new').click();await f.dom.wait(()=>!f.action('retry-conversations').hidden);await f.idle();const actual=structuredClone(f.catalogue()),posts=f.transport.calls.filter(call=>call.options.method==='POST').length;
 f.action('retry-conversations').click();await f.idle();assert.deepEqual(f.catalogue(),actual);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,posts);
 assert.equal(f.listAction('refresh').disabled,false,'a conflict must not lock the only route back to current data');f.listAction('refresh').click();await f.idle();
 assert.equal(f.action('retry-conversations').hidden,true);assert.equal(f.listRows().length,2);assert.equal(f.listAction('new').disabled,false);assert.equal(f.models.length,1);
});

test('warm panel reopen preserves its DOM and scroll without file requests, while an account change disposes it',async t=>{
 const f=await fixture(t);await f.send('保留窗口');const panel=f.panel,row=f.rows()[0],transcript=f.dom.get('助手对话');transcript.parentNode.scrollTop=87;
 const calls=f.transport.calls.length;for(let turn=0;turn<5;turn++){
  await f.close();assert.equal(f.dom.observers.size,0);assert.equal(panel.element.isConnected,true);
  if(turn===2)assert.deepEqual(await Promise.all([panel.reopen(),panel.reopen()]),[true,true]);else assert.equal(await panel.reopen(),true);
  assert.equal(f.rows()[0],row);assert.equal(transcript.parentNode.scrollTop,87);assert.equal(f.transport.calls.length,calls);assert.equal(f.dom.observers.size,1);
 }
 await f.close();f.namespace='st-user:another-account';f.transport.namespace=f.namespace;assert.equal(await panel.reopen(),false);assert.equal(panel.element.isConnected,false);assert.equal(f.transport.calls.length,calls);assert.equal(f.dom.observers.size,0);
});

test('a changed ST chat releases the hidden panel and independently loads that chat default without carrying old rows',async t=>{
 const f=await fixture(t);await f.send('A 的特助记录');const old=f.panel,hostB=hostFor('B');const b=await f.seed(hostB,[row('B 的特助记录','B 的旧回答')]);
 await f.close();const before=f.transport.calls.length;f.host=hostB;f.epoch++;
 assert.equal(await old.reopen(),false);assert.equal(old.element.isConnected,false);assert.equal(f.dom.observers.size,0);assert.equal(f.transport.calls.length,before);
 await f.open();assert.notEqual(f.panel,old);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'B 的特助记录');
 assert.equal(f.catalogue().defaults.find(entry=>entry.ownerKey===b),undefined,'opening old history does not silently register it');assert.equal(f.catalogue().defaults.find(entry=>entry.ownerKey===f.base).key,f.base);assert.equal(f.models.length,1);
 assert.equal(f.transport.calls.slice(before).filter(call=>call.options.method==='POST').length,0);f.showList();assert.ok(f.listRows().some(entry=>entry.dataset.paConversationKey===b),'old history stays visible as an in-memory list entry');
 assert.equal(f.remote(f.base).rows[0].user,'A 的特助记录');
});

test('remote deletion during a model reply preserves copyable output but neither saves nor resurrects the deleted conversation',async t=>{
 const f=await fixture(t);await f.send('之前已保存的问题');const original=structuredClone(f.remote(f.base));
 f.mode='hold';f.question().value='回复中会被另一页面删除';f.question().emit('input');f.action('send').click();
 await f.dom.wait(()=>f.models.length===2&&f.rows()[1]?.querySelector('.qm-pa-reply').textContent==='部分回答');
 const source=await f.capture(),other=await openProseAssistantConversations({source,isCurrent:()=>f.live});await other.delete([f.base]);other.close();source.close();
 const before=f.transport.calls.filter(call=>call.options.method==='POST').length;f.finishReply();await f.idle();
 assert.equal(f.models.length,2);assert.deepEqual(f.remote(f.base),original);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,before,'the deleted conversation receives neither a history write nor a metadata resurrection');
 assert.match(f.notice(),/已从列表删除.*回复未保存/);assert.equal(f.action('retry-history').hidden,true);assert.equal(f.action('send').disabled,true);
 const copy=f.rows()[1].querySelector('[data-pa-action="copy"]');assert.equal(copy.disabled,false);copy.click();await f.dom.wait(()=>f.copies.length===1);assert.deepEqual(f.copies,['部分回答，已完成']);
 f.confirmApproval=false;f.action('close').click();await f.dom.wait(()=>f.confirmations.length===1);await f.idle();assert.match(f.confirmations[0],/未确认保存.*仍要关闭/);assert.equal(f.panel.visible,true,'cancelling close preserves the unsaved answer');
 f.confirmApproval=true;const previous=f.panel;await f.close();await previous.finished;assert.equal(previous.element.isConnected,false,'unsaved closed panel is disposed, not retained');
 await f.open();assert.equal(f.rows().length,0);f.showList();assert.equal(f.listRows().length,0);assert.equal(f.models.length,2);assert.deepEqual(f.remote(f.base),original);assert.equal(f.catalogue().entries.find(entry=>entry.key===f.base).deleted,true);
});

test('streaming replies do not repaint a hidden conversation list on every chunk',async t=>{
 const f=await fixture(t);await f.send('已保存问题');f.showList();assert.equal(f.listRows().length,1);f.action('back').click();
 const list=f.dom.get('最近特助对话'),original=list.setAttribute.bind(list);let paints=0;
 t.mock.method(list,'setAttribute',(name,value)=>{if(name==='aria-busy')paints++;return original(name,value);});
 f.mode='hold';f.question().value='分段回复';f.question().emit('input');f.action('send').click();await f.dom.wait(()=>f.models.length===2&&f.rows()[1]?.querySelector('.qm-pa-reply').textContent==='部分回答');
 let expected='部分回答';for(const chunk of ['一','二','三','四']){expected+=chunk;f.appendReply(chunk);await f.dom.wait(()=>f.rows()[1].querySelector('.qm-pa-reply').textContent===expected);}
 f.finishReply();await f.idle();assert.equal(list.hidden,true);assert.equal(paints,0,'the hidden list is not rendered during input, streaming or final save');
 f.showList();assert.ok(paints>0,'the observation still sees the actual visible list render');assert.equal(f.listRows().length,1);assert.equal(f.models.length,2);
});
