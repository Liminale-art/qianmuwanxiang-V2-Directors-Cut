import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {configureStAccountStorage} from '../qianmu-st-account-storage.js';
import {openNativeProseAssistantHistory} from '../qianmu-prose-assistant-native.js';
import {openProseAssistantPanel} from '../qianmu-prose-assistant-panel.js';
import {captureProseAssistantChatSource} from '../qianmu-prose-assistant-source.js';
import {emptyProseAssistantHistory} from '../qianmu-prose-assistant-history-contract.js';
import {EventEmitter} from 'node:events';
import {streamCheckpointTransport} from './helpers/stream-checkpoint-fixture.mjs';
import {proseAssistantPanelDom} from './helpers/prose-assistant-panel-dom.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(t){
 const raw='st-user:assistant-integration',account='st-user:'+digest(raw.slice(8));
 const key=JSON.stringify(['qianmu-prose-assistant-offstage-v1',account]);
 const slot='assistant-'+digest(key),schema='qianmu.st-account-document.v1',scope=digest(`${schema}\0${raw}`);
 const state={version:1,namespace:key,revision:1,updatedAt:1,rows:[{id:1,user:'问题',assistant:'回答',status:'complete',reference:null}]};
 const text=JSON.stringify({schema,scope,slot,value:state}),fingerprint=digest(text),prefix=`qianmu-v2-${scope}-${slot}`;
 const files=new Map([[`${prefix}.json`,JSON.stringify({schema:'qianmu.st-account-head.v1',scope,slot,fingerprint})],[`${prefix}-${fingerprint}.json`,text]]);
 const f={namespace:raw,live:true,identity:0,gets:0,beforeReply:null};
 const resolveNamespace=async()=>{f.identity++;return f.namespace;};
 const fetchImpl=async(url,options)=>{
  assert.equal(options.method,'GET','reading an existing conversation must not upload');f.gets++;
  const path=new URL(url,'https://st.fixture.invalid');assert.equal(path.origin,'https://st.fixture.invalid');
  const body=files.get(path.pathname.split('/').at(-1));assert.ok(body,'only exact owned fixture files are readable');
  f.beforeReply?.();return new Response(body,{headers:{'content-type':'application/json'}});
 };
 t.mock.method(globalThis,'fetch',fetchImpl);
 configureStAccountStorage({resolveNamespace,isCurrent:()=>f.live,headers:()=>({}),fetchImpl,origin:'https://st.fixture.invalid'});
 const source={key,scope:{namespace:account},assertCurrent:()=>f.live,guard:async()=>f.live&&await resolveNamespace()===raw};
 f.open=()=>openNativeProseAssistantHistory({source,isCurrent:()=>f.live});return f;
}

test('real assistant/native chain reads two files with bounded live account checks, no nested authorization cache',async t=>{
 const f=fixture(t),history=await f.open();assert.equal(history.initialHistory().rows[0].assistant,'回答');
 assert.equal(f.gets,2);assert.ok(f.identity<=20,`identity checks ${f.identity} must not multiply at every inner guard`);
 history.close();
});

test('real assistant/native chain rejects an account switch while its first file reply is in flight',async t=>{
 const f=fixture(t);f.beforeReply=()=>{f.namespace='st-user:other';};
 await assert.rejects(f.open());assert.equal(f.gets,1,'the original body must not be requested after account change');
});

test('real assistant/native chain rejects closure during a file read without publishing late history',async t=>{
 const f=fixture(t);f.beforeReply=()=>{f.live=false;};
 await assert.rejects(f.open());assert.equal(f.gets,1);
});

async function panelFixture(t) {
 const namespace='st-user:assistant-panel-integration',transport=streamCheckpointTransport(namespace),dom=proseAssistantPanelDom();
 const host={chatId:'Fixture chat',characterId:0,characters:[{avatar:'Fixture.png',chat:'Fixture chat'}],chatMetadata:{},eventSource:new EventEmitter(),chat:[{mes:'旧正文'},{mes:'用户楼层',is_user:true},{mes:'最近正文'}]};
 const f={transport,dom,host,live:true,panel:null,models:[],reads:[],mode:'json',streamCancelled:false};
 const source={getContext:()=>host,epoch:()=>0,resolveNamespace:async()=>namespace,isCurrent:()=>f.live,readText:(message,floor)=>{f.reads.push(floor);return message.mes;}};
 // Seed an actual empty remote document so this unit does not pretend an
 // IndexedDB migration double is the native ST persistence path.
 const captured=await captureProseAssistantChatSource(source);f.key=captured.key;captured.close();
 f.slot='assistant-'+digest(f.key);const store=await transport.createStorage({maxBytes:4*1024*1024+2048});
 await store.write(f.slot,emptyProseAssistantHistory(f.key),{expectedFingerprint:null});store.close();transport.calls.length=0;transport.configure();
 t.mock.method(globalThis,'fetch',()=>assert.fail('unexpected real network request'));
 const request=async(url,options)=>{
  assert.equal(url,'/api/backends/chat-completions/generate');assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');
  assert.equal(options.headers['X-CSRF-Token'],'fixture-csrf');
  const body=JSON.parse(options.body);f.models.push({body,signal:options.signal});
  assert.equal(body.custom_url,'https://assistant-model.fixture.invalid/v1');assert.equal(body.custom_include_headers,'Authorization: Bearer fixture-assistant-key');
  if(f.mode==='error')return new Response('PRIVATE upstream detail',{status:401});
  if(f.mode==='hold')return new Response(new ReadableStream({start(controller){
   controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"半截回答"}}]}\n\n'));
   f.completeStream=()=>{controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"，已完成"},"finish_reason":"stop"}]}\n\n'));controller.close();};
  },cancel(){f.streamCancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  const answer='完整回答 '+f.models.length;
  if(f.mode==='stream')return new Response(`data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:'stop'}]})}\n\n`,{headers:{'content-type':'text/event-stream'}});
  return new Response(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});
 };
 f.open=async()=>{f.panel=await openProseAssistantPanel({parent:dom.parent,source,profiles:[{id:'fixture',name:'Fixture',apiUrl:'https://assistant-model.fixture.invalid/v1',apiKey:'fixture-assistant-key',model:'fixture-model'}],selection:{mode:'profile',profileId:'fixture'},referenceFloors:3,systemPrompt:'',getRequestHeaders:()=>({'X-CSRF-Token':'fixture-csrf'}),fetchImpl:request,copy:async()=>{},confirm:async()=>true,isCurrent:()=>f.live,historyFactory:openNativeProseAssistantHistory});await f.panel.ready;return f.panel;};
 f.action=name=>dom.all().find(node=>node.dataset.paAction===name);
 f.question=()=>dom.get('向场外特助提问');
 f.rows=()=>dom.all().filter(node=>Object.hasOwn(node.dataset,'paTurn'));
 f.notice=()=>dom.all().find(node=>Object.hasOwn(node.dataset,'paHistory')).textContent;
 f.status=()=>dom.all().find(node=>Object.hasOwn(node.dataset,'paStatus')).textContent;
 f.idle=()=>dom.wait(()=>f.panel.element.getAttribute('aria-busy')==='false');
 f.send=async text=>{const count=f.models.length;f.question().value=text;f.question().emit('input');assert.equal(f.action('send').disabled,false);f.action('send').click();await dom.wait(()=>f.models.length===count+1);};
 f.remote=()=>{const heads=[...transport.files.values()].map(JSON.parse).filter(value=>value.schema==='qianmu.st-account-head.v1'&&value.slot===f.slot);assert.equal(heads.length,1);const head=heads[0];return JSON.parse(transport.files.get(`qianmu-v2-${head.scope}-${head.slot}-${head.fingerprint}.json`)).value;};
 f.close=async()=>{f.action('close').click();await f.panel.finished;assert.equal(dom.observers.size,0);};
 t.after(()=>{f.panel?.dispose();f.live=false;});await f.open();return f;
}

test('actual panel sends first and follow-up questions, persists native history and cold reopens without model replay',async t=>{
 const f=await panelFixture(t),before=structuredClone(f.host.chat);assert.equal(f.rows().length,0);assert.equal(f.models.length,0);assert.equal(f.transport.calls.some(call=>call.options.method==='POST'),false);
 await f.send('第一问');await f.idle();assert.equal(f.question().value,'');assert.equal(f.models.length,1);assert.deepEqual(f.reads,[2,1,0]);
 const first=f.models[0].body.messages;assert.equal(JSON.parse(first.at(-1).content).reference.text,'最近正文');assert.equal(first.some(row=>row.role==='system'),false);
 assert.deepEqual(f.remote().rows.map(row=>[row.user,row.assistant,row.status]),[['第一问','完整回答 1','complete']]);
 f.mode='stream';await f.send('追问');await f.idle();assert.equal(f.models.length,2);
 assert.deepEqual(f.models[1].body.messages.slice(0,2),[{role:'user',content:'第一问'},{role:'assistant',content:'完整回答 1'}]);
 const saved=f.remote();assert.equal(saved.rows.length,2);assert.equal(saved.rows[1].assistant,'完整回答 2');assert.equal(f.notice(),'');assert.deepEqual(f.host.chat,before);
 const posts=f.transport.calls.filter(call=>call.options.method==='POST').length;await f.close();await f.open();
 assert.equal(f.models.length,2);assert.equal(f.rows().length,2);assert.deepEqual(f.remote(),saved);assert.equal(f.transport.calls.filter(call=>call.options.method==='POST').length,posts);
 assert.equal(f.rows()[1].querySelector('pre').textContent,'完整回答 2');assert.doesNotMatch([...f.transport.files.values()].join(''),/fixture-assistant-key/);
});

test('actual panel stop preserves input and partial native history, which is not sent as a completed follow-up',async t=>{
 const f=await panelFixture(t);f.mode='hold';await f.send('准备停止的问题');await f.dom.wait(()=>f.rows()[0]?.querySelector('pre').textContent==='半截回答');
 f.action('stop').click();await f.idle();assert.equal(f.models.length,1);assert.equal(f.models[0].signal.aborted,true);assert.equal(f.streamCancelled,true);assert.equal(f.question().value,'准备停止的问题');
 assert.equal(f.remote().rows[0].status,'cancelled');assert.equal(f.remote().rows[0].assistant,'半截回答');
 await f.close();await f.open();assert.equal(f.models.length,1);assert.match(f.rows()[0].querySelector('small').textContent,/停止/);
 f.mode='json';await f.send('新问题');await f.idle();assert.equal(f.models.length,2);
 assert.doesNotMatch(JSON.stringify(f.models[1].body.messages),/准备停止的问题|半截回答/);assert.equal(f.remote().rows[1].status,'complete');
});

test('actual panel reference setting changes the next payload without reading prose at zero',async t=>{
 const f=await panelFixture(t),range=f.dom.get('参考楼层数');
 f.action('settings').click();range.value='0';range.emit('input');f.action('back').click();
 await f.send('不参考正文的问题');await f.idle();
 assert.deepEqual(f.reads,[]);assert.equal(f.models.length,1);
 const first=JSON.parse(f.models[0].body.messages.at(-1).content);
 assert.equal(first.reference,null);assert.deepEqual(first.previous,[]);assert.equal(f.remote().rows[0].reference,null);
 assert.doesNotMatch(JSON.stringify(f.models[0].body.messages),/旧正文|用户楼层|最近正文/);
 f.action('settings').click();range.value='2';range.emit('input');f.action('back').click();
 await f.send('再参考两层');await f.idle();assert.deepEqual(f.reads,[2,1]);assert.equal(f.models.length,2);
 const next=JSON.parse(f.models[1].body.messages.at(-1).content);
 assert.equal(next.reference.text,'最近正文');assert.deepEqual(next.previous,[{floor:1,speaker:'user',text:'用户楼层'}]);
 assert.deepEqual(f.models[1].body.messages.slice(0,2),[{role:'user',content:'不参考正文的问题'},{role:'assistant',content:'完整回答 1'}]);
});

test('actual panel keeps a newly typed draft through reply completion and ignores composing send shortcuts',async t=>{
 const f=await panelFixture(t);f.mode='hold';await f.send('正在回答的问题');
 await f.dom.wait(()=>f.rows()[0]?.querySelector('pre').textContent==='半截回答');
 f.question().value='提前写好的下一问';f.question().emit('input');
 f.question().emit('keydown',{ctrlKey:true,key:'Enter',isComposing:false});
 assert.equal(f.models.length,1,'a shortcut while busy must not queue another paid request');
 f.completeStream();await f.idle();
 assert.equal(f.question().value,'提前写好的下一问');assert.equal(f.remote().rows[0].assistant,'半截回答，已完成');
 assert.equal(f.remote().rows[0].status,'complete');assert.equal(f.models.length,1,'finishing a reply must not auto-send the draft');
 f.question().emit('keydown',{ctrlKey:true,key:'Enter',isComposing:true});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.models.length,1);assert.equal(f.question().value,'提前写好的下一问');
 f.mode='json';f.action('send').click();await f.dom.wait(()=>f.models.length===2);await f.idle();
 assert.equal(f.question().value,'');assert.equal(JSON.parse(f.models[1].body.messages.at(-1).content).question,'提前写好的下一问');
 assert.deepEqual(f.remote().rows.map(row=>row.user),['正在回答的问题','提前写好的下一问']);
});

test('actual panel HTTP failure sends once, retains question and records no false completed answer',async t=>{
 const f=await panelFixture(t);f.mode='error';await f.send('连接失败后保留的问题');await f.idle();
 assert.equal(f.models.length,1);assert.equal(f.question().value,'连接失败后保留的问题');assert.match(f.status(),/HTTP 401/);assert.doesNotMatch(f.status(),/PRIVATE|fixture-assistant-key/);
 assert.equal(f.remote().rows[0].status,'failed');assert.equal(f.remote().rows[0].assistant,'');
 await f.close();await f.open();assert.equal(f.models.length,1);assert.match(f.rows()[0].querySelector('small').textContent,/未完成/);
});

test('actual panel failed native save retains the reply and retries only storage, never the model',async t=>{
 const f=await panelFixture(t),before=f.remote();let rejected=0;
 f.transport.hook=({options,json})=>{if(options.method==='POST'){rejected++;return json({error:'PRIVATE storage detail'},503);}};
 await f.send('保存失败测试');await f.idle();assert.equal(f.models.length,1);assert.equal(rejected,1);assert.deepEqual(f.remote(),before);
 assert.equal(f.rows()[0].querySelector('pre').textContent,'完整回答 1');assert.match(f.notice(),/保存未确认/);assert.doesNotMatch(f.notice(),/PRIVATE|保存成功|已保存/);
 assert.equal(f.action('retry-history').hidden,false);assert.equal(f.action('send').disabled,true);
 f.transport.hook=null;f.action('retry-history').click();await f.idle();assert.equal(f.models.length,1);assert.equal(f.notice(),'');
 assert.equal(f.remote().rows[0].assistant,'完整回答 1');await f.close();await f.open();assert.equal(f.models.length,1);assert.equal(f.rows()[0].querySelector('pre').textContent,'完整回答 1');
});
