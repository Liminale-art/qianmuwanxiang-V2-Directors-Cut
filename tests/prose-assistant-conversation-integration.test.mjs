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
const titleInstruction=body=>body.messages.find(message=>message.role==='system'&&/\[\[qianmu-title:/.test(message.content))?.content;
const titleSuffix=(body,title)=>{const id=titleInstruction(body)?.match(/\[\[qianmu-title:([0-9a-f-]{36})\]\]/)?.[1];assert.ok(id,'the first unnamed offstage request includes its single-response naming instruction');return `\n[[qianmu-title:${id}]]${title}[[/qianmu-title:${id}]]`;};

const historyRows=count=>Array.from({length:count},(_,index)=>({...row('问题 '+(index+1),'回答 '+(index+1)),id:index+1}));
const turnIds=f=>f.rows().map(entry=>Number(entry.dataset.paTurn));

// Deliberately synthetic geometry: exercises the scroll arithmetic, not browser layout.
function messageLayout(dom){
 const create=dom.doc.createElement.bind(dom.doc),visible=element=>{for(let current=element;current;current=current.parentNode)if(current.hidden)return false;return true;};
 const articleHeight=article=>200+article.querySelector('.qm-pa-reply').textContent.length,olderHeight=main=>main.querySelector('[data-pa-action="older-messages"]')?.hidden===false?36:0;
 const rect=(top,height)=>({top,bottom:top+height,left:0,right:400,width:400,height,x:0,y:top});
 dom.doc.createElement=tag=>{
  const element=create(tag);
  if(tag==='article')element.getBoundingClientRect=()=>{
   const main=element.closest('main');if(!main||!visible(element))return rect(0,0);
   const preceding=main.querySelectorAll('[data-pa-turn]'),index=preceding.indexOf(element),offset=preceding.slice(0,index).reduce((total,article)=>total+articleHeight(article),0);
   return rect(100+olderHeight(main)+offset-main.scrollTop,articleHeight(element));
  };
  if(tag!=='main')return element;let top=0;
  const height=()=>element.querySelectorAll('[data-pa-turn]').reduce((total,article)=>total+articleHeight(article),0)+olderHeight(element);
  element.getBoundingClientRect=()=>visible(element)?rect(100,400):rect(0,0);
  Object.defineProperties(element,{
   clientHeight:{configurable:true,get:()=>visible(element)?400:0},
   scrollHeight:{configurable:true,get:()=>visible(element)?height():0},
   scrollTop:{configurable:true,get:()=>visible(element)?Math.min(top,Math.max(0,height()-400)):top,set:value=>{top=Math.max(0,Math.min(Number(value)||0,Math.max(0,element.scrollHeight-element.clientHeight)));}},
  });return element;
 };
}

async function fixture(t,{initialRows=[],offstage=false,messageViewport=false}={}){
 const namespace='st-user:conversation-panel-fixture',transport=streamCheckpointTransport(namespace),dom=proseAssistantPanelDom();
 if(messageViewport)messageLayout(dom);
 const f={namespace,transport,dom,host:hostFor(),epoch:0,live:true,panel:null,models:[],proseReads:[],confirmations:[],copies:[],mode:'json',confirmApproval:true};
 if(offstage){delete f.host.chatId;f.host.chat=[];}
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
   f.failReply=()=>controller.error(new Error('synthetic assistant stream failure'));
   f.finishReply=()=>f.appendReply('，已完成',true);f.appendReply('部分回答');
  }}),{headers:{'content-type':'text/event-stream'}});
  return Response.json({choices:[{message:{content:f.replyText?f.replyText(body):'回答 '+f.models.length},finish_reason:'stop'}]});
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
 f.rename=async(key,title)=>{f.showList();const button=dom.all().find(node=>node.dataset.paRenameKey===key);assert.ok(button);button.click();dom.get('对话名称').value=title;f.listAction('save-name').click();await dom.wait(()=>f.catalogue()?.entries.find(entry=>entry.key===key)?.title===title);await f.idle();await dom.wait(()=>!dom.all().some(node=>Object.hasOwn(node.dataset,'paConversationEditor')));};
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

test('the first independent reply names its catalog in the existing write without leaking its marker to rendering, copy or follow-up history',async t=>{
 const f=await fixture(t,{offstage:true});f.replyText=body=>'这是正文。'+titleSuffix(body,'岩彩材料');await f.send('介绍岩彩');
 assert.equal(f.models.length,1);assert.equal(f.rows()[0].querySelector('.qm-pa-reply').textContent,'这是正文。');assert.equal(f.remote(f.base).rows[0].assistant,'这是正文。');
 const entry=f.catalogue().entries[0];assert.equal(entry.title,'岩彩材料');assert.equal(entry.titleSource,'auto');assert.equal(f.catalogue().version,2);
 const uploads=f.transport.calls.map(uploaded).filter(Boolean);assert.equal(uploads.length,4);assert.equal(uploads.filter(value=>value.slot==='assistant-conversations').length,2);assert.equal(uploads.filter(value=>value.schema==='qianmu.st-account-document.v1').length,1);assert.equal(uploads.filter(value=>value.schema==='qianmu.st-account-head.v1').length,1);
 f.rows()[0].querySelector('[data-pa-action="copy"]').click();await f.dom.wait(()=>f.copies.length===1);assert.deepEqual(f.copies,['这是正文。']);
 f.replyText=body=>{assert.equal(titleInstruction(body),undefined);assert.doesNotMatch(JSON.stringify(body.messages),/qianmu-title:/);return '第二次正文。';};await f.send('再介绍颜料');
 assert.equal(f.models.length,2);assert.equal(f.catalogue().entries[0].title,'岩彩材料');assert.doesNotMatch(JSON.stringify(f.remote(f.base)),/qianmu-title:/);assert.equal(f.remote(f.base).rows.length,2);
});

test('manual rename registers a legacy ghost atomically, survives cold open, changes no messages and permanently takes naming priority',async t=>{
 const f=await fixture(t,{offstage:true,initialRows:[row()]}),original=structuredClone(f.remote(f.base)),files=new Map(f.transport.files);
 assert.equal(f.catalogue(),undefined);await f.rename(f.base,'我的手工笔记');assert.equal(f.catalogue().entries[0].titleSource,'manual');assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,1);assert.deepEqual(f.remote(f.base),original);
 assert.deepEqual(new Map([...f.transport.files].filter(([name])=>!name.endsWith('-assistant-conversations.snapshot.json'))),files);await f.cold();f.showList();assert.match(f.listRows()[0].textContent,/我的手工笔记/);
 await f.choose(f.base);f.replyText=body=>{assert.equal(titleInstruction(body),undefined);return '不会改变手动名称';};await f.send('继续笔记');assert.equal(f.catalogue().entries[0].title,'我的手工笔记');
 const before=structuredClone(f.remote(f.base)),posts=f.transport.calls.filter(call=>call.options.method==='POST').length;await f.rename(f.base,'独立对话');assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,posts+1);assert.deepEqual(f.remote(f.base),before);
 await f.cold();await f.send('再次继续');assert.equal(f.catalogue().entries[0].title,'独立对话');assert.equal(f.catalogue().entries[0].titleSource,'manual');assert.equal(f.models.length,2);
});

test('missing or invalid automatic title never fails the normal reply or sends an extra model request',async t=>{
 for(const invalid of [false,true])await t.test(invalid?'invalid title':'no title',async t=>{
  const f=await fixture(t,{offstage:true});let returned;f.replyText=body=>returned='正常回复'+(invalid?titleSuffix(body,'<b>不接受的标题</b>'):'');await f.send('照常回答');
  assert.equal(f.models.length,1);assert.equal(f.remote(f.base).rows[0].assistant,returned);assert.equal(f.remote(f.base).rows[0].status,'complete');assert.equal(f.catalogue().entries[0].title,'独立对话');assert.equal(f.catalogue().entries[0].titleSource,undefined);assert.equal(f.catalogue().version,1);assert.equal(f.status(),'');assert.equal(f.notice(),'');assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,4);
 });
});

test('a streaming title split across delimiters stays out of visible text and is named only after successful completion',async t=>{
 const f=await fixture(t,{offstage:true});f.mode='hold';f.question().value='流式介绍';f.question().emit('input');f.action('send').click();await f.dom.wait(()=>f.models.length===1&&f.rows()[0]?.querySelector('.qm-pa-reply').textContent==='部分回答');
 const suffix=titleSuffix(f.models[0],'流式笔记'),chunks=[suffix.slice(0,2),suffix.slice(2,19),suffix.slice(19,55),suffix.slice(55,-5),suffix.slice(-5)];
 for(const chunk of chunks){f.appendReply(chunk);await new Promise(done=>setImmediate(done));assert.equal(f.rows()[0].querySelector('.qm-pa-reply').textContent,'部分回答');assert.equal(f.catalogue().entries[0].titleSource,undefined);}
 f.appendReply('',true);await f.idle();assert.equal(f.remote(f.base).rows[0].assistant,'部分回答');assert.equal(f.catalogue().entries[0].title,'流式笔记');assert.equal(f.catalogue().entries[0].titleSource,'auto');assert.equal(f.models.length,1);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,4);
});

test('stopping after a streamed title arrives does not confirm that title or save its marker',async t=>{
 const f=await fixture(t,{offstage:true});f.mode='hold';f.question().value='稍后停止';f.question().emit('input');f.action('send').click();await f.dom.wait(()=>f.models.length===1&&f.rows()[0]?.querySelector('.qm-pa-reply').textContent==='部分回答');
 f.appendReply(titleSuffix(f.models[0],'不能提前确认'));await new Promise(done=>setImmediate(done));f.action('stop').click();await f.idle();
 assert.equal(f.remote(f.base).rows[0].assistant,'部分回答');assert.equal(f.remote(f.base).rows[0].status,'cancelled');assert.equal(f.catalogue().entries[0].title,'独立对话');assert.equal(f.catalogue().entries[0].titleSource,undefined);assert.equal(f.catalogue().version,1);assert.equal(f.models.length,1);assert.doesNotMatch(JSON.stringify(f.remote(f.base)),/qianmu-title:/);
});

test('failed history save retains the same automatic title candidate for storage retry without another model request',async t=>{
 const f=await fixture(t,{offstage:true});f.replyText=body=>'可保存正文'+titleSuffix(body,'保存后才命名');let failed=false;
 f.transport.hook=({path,options,json})=>{if(!failed&&uploaded({path,options})?.schema==='qianmu.st-account-document.v1'){failed=true;return json({},503);}};
 await f.send('保存失败一次');assert.equal(f.models.length,1);assert.equal(f.remote(f.base).rows.length,0);assert.equal(f.catalogue().entries[0].titleSource,undefined);assert.equal(f.action('retry-history').hidden,false);
 f.transport.hook=null;f.action('retry-history').click();await f.idle();assert.equal(f.remote(f.base).rows[0].assistant,'可保存正文');assert.equal(f.catalogue().entries[0].title,'保存后才命名');assert.equal(f.catalogue().entries[0].titleSource,'auto');assert.equal(f.models.length,1);assert.equal(f.notice(),'');assert.equal(f.status(),'');
});

test('lost automatic-title directory receipt retries only its exact snapshot, never the model, message body or title generation',async t=>{
 const f=await fixture(t,{offstage:true});f.replyText=body=>'正文已保存'+titleSuffix(body,'回执丢失的标题');let lost=false;
 f.transport.hook=({path,options,files,json})=>{const value=uploaded({path,options});if(!lost&&value?.slot==='assistant-conversations'&&value.value.version===2){lost=true;const {name,data}=JSON.parse(options.body);files.set(name,Buffer.from(data,'base64').toString('utf8'));return json({},503);}};
 await f.send('回执丢失');assert.equal(lost,true);assert.equal(f.remote(f.base).rows[0].assistant,'正文已保存');assert.equal(f.action('retry-conversations').hidden,false);
 const files=new Map(f.transport.files),writes=f.transport.calls.filter(call=>call.options.method==='POST').length;f.transport.hook=null;f.action('retry-conversations').click();await f.idle();
 assert.deepEqual(f.transport.files,files);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,writes);assert.equal(f.models.length,1);assert.equal(f.catalogue().entries[0].title,'回执丢失的标题');assert.equal(f.action('retry-conversations').hidden,true);
 f.replyText=body=>{assert.equal(titleInstruction(body),undefined);return '后续正文';};await f.send('再问一次');assert.equal(f.models.length,2);assert.equal(f.catalogue().entries[0].title,'回执丢失的标题');assert.doesNotMatch(JSON.stringify(f.remote(f.base)),/qianmu-title:/);
});

test('long history opens the newest ten turns, expands older batches without reads or writes, and retains the full original',async t=>{
 const initial=historyRows(35),f=await fixture(t,{initialRows:initial,messageViewport:true}),main=f.dom.get('助手对话').parentNode;
 assert.deepEqual(turnIds(f),initial.slice(-10).map(item=>item.id));assert.equal(main.scrollTop,main.scrollHeight-main.clientHeight);
 const original=structuredClone(f.remote(f.base)),calls=f.transport.calls.length,newest=f.rows().at(-1);
 for(const size of [20,30,35]){f.action('older-messages').click();assert.equal(f.rows().length,size);assert.deepEqual(turnIds(f),initial.slice(-size).map(item=>item.id));assert.equal(f.rows().at(-1),newest);}
 assert.equal(f.action('older-messages').hidden,true);assert.equal(f.transport.calls.length,calls,'display paging performs no remote history or metadata work');
 assert.deepEqual(f.remote(f.base),original);assert.equal(f.models.length,0);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,0);
});

test('upward paging compensates inserted height and warm reopen or current-list return keeps the expanded rows and position',async t=>{
 const f=await fixture(t,{initialRows:historyRows(35),messageViewport:true}),main=f.dom.get('助手对话').parentNode,calls=f.transport.calls.length;
 const oldHeight=main.scrollHeight,oldest=f.rows()[0];main.scrollTop=20;main.emit('scroll');
 assert.equal(f.rows().length,20);assert.equal(f.rows()[10],oldest);assert.equal(main.scrollTop,20+main.scrollHeight-oldHeight,'the old first visible content keeps its offset');
 const expanded=[...f.rows()],position=main.scrollTop,panel=f.panel;
 f.showList();f.listRows().find(entry=>entry.dataset.paConversationKey===f.base).click();assert.deepEqual(f.rows(),expanded);assert.equal(main.scrollTop,position);
 for(let cycle=0;cycle<3;cycle++){await f.close();assert.equal(await panel.reopen(),true);assert.deepEqual(f.rows(),expanded);assert.equal(main.scrollTop,position);}
 assert.equal(f.transport.calls.length,calls);assert.equal(f.models.length,0);
});

test('new streamed replies preserve an expanded older reading position until back-to-latest is chosen',async t=>{
 const f=await fixture(t,{initialRows:historyRows(25),messageViewport:true}),main=f.dom.get('助手对话').parentNode;
 f.action('older-messages').click();const oldest=f.rows()[0];main.scrollTop=240;main.emit('scroll');assert.equal(f.action('latest-messages').hidden,false);
 f.mode='hold';f.question().value='追加问题';f.question().emit('input');f.action('send').click();await f.dom.wait(()=>f.models.length===1&&f.rows().at(-1)?.querySelector('.qm-pa-reply').textContent==='部分回答');
 assert.equal(f.rows().length,21);assert.equal(f.rows()[0],oldest);assert.equal(main.scrollTop,240,'a new reply does not pull an older reader down');
 f.appendReply('继续输出'.repeat(30));await f.dom.wait(()=>f.rows().at(-1).querySelector('.qm-pa-reply').textContent.length>100);assert.equal(main.scrollTop,240);
 f.action('latest-messages').click();assert.equal(main.scrollTop,main.scrollHeight-main.clientHeight);assert.equal(f.action('latest-messages').hidden,true);assert.equal(f.rows()[0],oldest,'jumping to the newest reply does not collapse expanded history');
 f.appendReply('更多输出'.repeat(30));await f.dom.wait(()=>f.rows().at(-1).querySelector('.qm-pa-reply').textContent.length>200);assert.equal(main.scrollTop,main.scrollHeight-main.clientHeight,'once at the latest reply, later chunks remain in view');
 f.finishReply();await f.idle();assert.equal(f.remote(f.base).rows.length,26);assert.deepEqual(f.remote(f.base).rows.slice(0,25),historyRows(25));assert.equal(f.models.length,1);
});

test('settings round trips preserve old reading positions but resume latest-following after a reply completes while hidden',async t=>{
 const f=await fixture(t,{initialRows:historyRows(25),messageViewport:true}),main=f.dom.get('助手对话').parentNode;
 f.action('older-messages').click();main.scrollTop=240;main.emit('scroll');const expanded=[...f.rows()],calls=f.transport.calls.length;
 f.action('settings').click();assert.equal(main.hidden,true);assert.equal(f.action('latest-messages').hidden,true);f.action('back').click();
 assert.deepEqual(f.rows(),expanded);assert.equal(main.scrollTop,240);assert.equal(f.transport.calls.length,calls,'opening settings alone performs no history work');
 f.mode='hold';
 for(const follow of [false,true]){
  if(follow)f.action('latest-messages').click();
  const before=f.models.length;f.question().value=follow?'跟随最新时离开':'阅读旧段时离开';f.question().emit('input');f.action('send').click();
  await f.dom.wait(()=>f.models.length===before+1&&f.rows().at(-1)?.querySelector('.qm-pa-reply').textContent==='部分回答');
  f.action('settings').click();assert.equal(main.hidden,true);f.appendReply('在设置页继续生成'.repeat(50));f.finishReply();await f.idle();
  assert.equal(f.action('latest-messages').hidden,true);f.action('back').click();assert.equal(main.hidden,false);assert.equal(f.rows()[0],expanded[0]);
  assert.equal(main.scrollTop,follow?main.scrollHeight-main.clientHeight:240);assert.equal(f.action('latest-messages').hidden,follow);assert.equal(f.models.length,before+1);
 }
 assert.equal(f.remote(f.base).rows.length,27);assert.deepEqual(f.remote(f.base).rows.slice(0,25),historyRows(25));assert.equal(f.models.length,2);
});

test('switching from the hidden directory resets only the new message window and positions its newest turns after it becomes visible',async t=>{
 const f=await fixture(t,{initialRows:historyRows(35),messageViewport:true}),main=f.dom.get('助手对话').parentNode;
 f.action('older-messages').click();main.scrollTop=180;main.emit('scroll');const original=structuredClone(f.remote(f.base));
 const thread=await f.create();assert.equal(f.rows().length,0);await f.send('另一个会话');assert.deepEqual(turnIds(f),[1]);assert.equal(f.rows()[0].querySelector('.qm-pa-user').textContent,'另一个会话');
 await f.choose(f.base);assert.deepEqual(turnIds(f),historyRows(35).slice(-10).map(item=>item.id));assert.equal(main.scrollTop,main.scrollHeight-main.clientHeight,'hidden-list loading must defer the latest scroll until main is visible');
 assert.deepEqual(f.remote(f.base),original);assert.equal(f.remote(thread).rows.length,1);assert.equal(f.models.length,1);
});

test('editing a previously paged-in reply changes only that original turn and never the displayed slice or hidden history',async t=>{
 const f=await fixture(t,{initialRows:historyRows(35),messageViewport:true}),main=f.dom.get('助手对话').parentNode;f.action('older-messages').click();main.scrollTop=220;main.emit('scroll');
 const old=structuredClone(f.remote(f.base).rows),target=f.rows()[0],ids=turnIds(f);target.querySelector('[data-pa-action="edit"]').click();f.dom.get('编辑助手回复').value='旧轮修订内容';f.action('save-reply').click();
 await f.dom.wait(()=>f.remote(f.base).rows[15].assistant==='旧轮修订内容');await f.idle();old[15].assistant='旧轮修订内容';
 assert.deepEqual(f.remote(f.base).rows,old);assert.deepEqual(turnIds(f),ids);assert.equal(f.rows()[0],target);assert.equal(main.scrollTop,220);assert.equal(f.models.length,0);
});

test('regenerating an older displayed question sends its actual preceding context, then removes only the approved tail on success',async t=>{
 const f=await fixture(t,{initialRows:historyRows(35),messageViewport:true});f.action('older-messages').click();const target=f.rows()[0];
 target.querySelector('[data-pa-action="edit-question"]').click();f.dom.get('编辑提问').value='第十六轮修订';f.action('save-reply').click();await f.dom.wait(()=>f.models.length===1);await f.idle();
 assert.match(f.confirmations.at(-1),/替换这一轮并删除之后/);const context=f.models[0].messages.slice(0,-1).filter(message=>message.role==='user');
 assert.equal(context.at(-1).content,'问题 15');assert.equal(context.length,6,'the model context window is independent of the rendered window');
 const persisted=f.remote(f.base).rows;assert.equal(persisted.length,16);assert.deepEqual(persisted.slice(0,15),historyRows(35).slice(0,15));assert.equal(persisted.at(-1).user,'第十六轮修订');assert.equal(persisted.at(-1).assistant,'回答 1');
 assert.equal(f.rows().at(-1).querySelector('.qm-pa-user').textContent,'第十六轮修订');assert.ok(!f.rows().some(entry=>entry.querySelector('.qm-pa-user').textContent==='问题 35'));assert.equal(f.models.length,1);
});

test('stopping an older regeneration restores every original turn including the temporarily hidden later tail',async t=>{
 const f=await fixture(t,{initialRows:historyRows(35),messageViewport:true}),main=f.dom.get('助手对话').parentNode;f.action('older-messages').click();main.scrollTop=240;main.emit('scroll');const before=structuredClone(f.remote(f.base)),ids=turnIds(f);
 f.mode='hold';f.rows()[0].querySelector('[data-pa-action="regenerate"]').click();await f.dom.wait(()=>f.models.length===1&&f.rows().at(-1)?.querySelector('.qm-pa-reply').textContent==='部分回答');
 assert.equal(main.scrollTop,0,'the temporarily shortened viewport is clamped while regeneration is running');
 f.action('stop').click();await f.idle();assert.deepEqual(f.remote(f.base),before);assert.deepEqual(turnIds(f),ids);assert.equal(f.rows().at(-1).querySelector('.qm-pa-user').textContent,'问题 35');assert.equal(f.models.length,1);
 assert.equal(main.scrollTop,240,'restoring a cancelled older regeneration restores its pre-request reading position, not the tail');
});

test('an older regeneration failing while settings are open restores its original reading position on return',async t=>{
 const f=await fixture(t,{initialRows:historyRows(35),messageViewport:true}),main=f.dom.get('助手对话').parentNode;f.action('older-messages').click();main.scrollTop=240;main.emit('scroll');
 const before=structuredClone(f.remote(f.base)),ids=turnIds(f);f.mode='hold';f.rows()[0].querySelector('[data-pa-action="regenerate"]').click();
 await f.dom.wait(()=>f.models.length===1&&f.rows().at(-1)?.querySelector('.qm-pa-reply').textContent==='部分回答');assert.equal(main.scrollTop,0);
 f.action('settings').click();assert.equal(main.hidden,true);f.failReply();await f.idle();assert.deepEqual(f.remote(f.base),before);assert.deepEqual(turnIds(f),ids);
 f.action('back').click();assert.equal(main.hidden,false);assert.equal(main.scrollTop,240,'failed hidden regeneration must restore the old viewport when it becomes visible');assert.equal(f.models.length,1);
});

test('successful regeneration of the last turn preserves a reader who scrolls upward during its stream',async t=>{
 const initial=historyRows(35),f=await fixture(t,{initialRows:initial,messageViewport:true}),main=f.dom.get('助手对话').parentNode;
 assert.equal(main.scrollTop,main.scrollHeight-main.clientHeight);f.mode='hold';f.rows().at(-1).querySelector('[data-pa-action="regenerate"]').click();
 await f.dom.wait(()=>f.models.length===1&&f.rows().at(-1)?.querySelector('.qm-pa-reply').textContent==='部分回答');main.scrollTop=240;main.emit('scroll');
 f.finishReply();await f.idle();assert.equal(main.scrollTop,240,'a successful final-turn regeneration is not an old-tail restoration');assert.equal(f.action('latest-messages').hidden,false);
 assert.deepEqual(f.remote(f.base).rows.slice(0,-1),initial.slice(0,-1));assert.equal(f.remote(f.base).rows.length,35);assert.equal(f.remote(f.base).rows.at(-1).assistant,'部分回答，已完成');assert.equal(f.models.length,1);
});

test('stopping an older regeneration after paging farther back preserves the original row anchor with the newly inserted height',async t=>{
 const initial=historyRows(35),f=await fixture(t,{initialRows:initial,messageViewport:true}),main=f.dom.get('助手对话').parentNode;f.action('older-messages').click();main.scrollTop=240;main.emit('scroll');
 const anchor=f.rows()[0],anchorId=anchor.dataset.paTurn,offset=anchor.getBoundingClientRect().top-main.getBoundingClientRect().top,before=structuredClone(f.remote(f.base));
 f.mode='hold';anchor.querySelector('[data-pa-action="regenerate"]').click();await f.dom.wait(()=>f.models.length===1&&f.rows().at(-1)?.querySelector('.qm-pa-reply').textContent==='部分回答');assert.equal(main.scrollTop,0);
 const calls=f.transport.calls.length;f.action('older-messages').click();assert.deepEqual(turnIds(f),initial.slice(5,16).map(item=>item.id));assert.equal(f.transport.calls.length,calls);
 const addedHeight=initial.slice(5,15).reduce((total,item)=>total+200+item.assistant.length,0);f.action('stop').click();await f.idle();
 assert.deepEqual(f.remote(f.base),before);assert.deepEqual(turnIds(f),initial.slice(5).map(item=>item.id));assert.equal(main.scrollTop,240+addedHeight,'restored position includes the older rows loaded during the request');
 const restored=f.rows().find(entry=>entry.dataset.paTurn===anchorId);assert.equal(restored.getBoundingClientRect().top-main.getBoundingClientRect().top,offset);assert.equal(f.models.length,1);
});

test('capacity guidance warns near the limit and a full conversation can create a new one without losing its original',async t=>{
 for(const count of [89,90,100])await t.test(String(count)+' turns',async t=>{
  const f=await fixture(t,{initialRows:historyRows(count),messageViewport:true}),notice=f.dom.all().find(element=>Object.hasOwn(element.dataset,'paCapacity'));
  assert.ok(notice);assert.equal(notice.hidden,count<90);assert.equal(f.models.length,0);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,0);
  if(count<100)return;
  const original=structuredClone(f.remote(f.base));assert.doesNotMatch(notice.textContent,/清空/);f.question().value='容量已满时未发出的草稿';f.question().emit('input');assert.equal(f.action('send').disabled,true);
  assert.equal(f.rows().at(-1).querySelector('[data-pa-action="edit"]').disabled,false);assert.equal(f.rows().at(-1).querySelector('[data-pa-action="regenerate"]').disabled,false);
  f.confirmApproval=false;f.action('capacity-new').click();await f.dom.wait(()=>f.confirmations.length===1);await f.idle();assert.equal(f.rows().length,10);assert.equal(f.question().value,'容量已满时未发出的草稿');assert.deepEqual(f.remote(f.base),original);
  f.confirmApproval=true;f.action('capacity-new').click();await f.dom.wait(()=>f.rows().length===0);await f.idle();assert.equal(f.models.length,0);assert.deepEqual(f.remote(f.base),original);assert.equal(f.catalogue().entries.length,2);
  assert.equal(notice.hidden,true);await f.send('新对话第一问');assert.equal(f.models.length,1);assert.deepEqual(f.remote(f.base),original);
 });
});
