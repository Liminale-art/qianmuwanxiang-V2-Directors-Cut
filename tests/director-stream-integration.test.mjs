import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseDirectorFinal, renderDirectorLive, paintModelLog } from '../qianmu-director-live.js';
const entry=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
const source=entry.slice(entry.indexOf('function makeStreamLogUpdater('),entry.indexOf('// MIGRATED to qianmu-storyboard-utils.js (commit 19)'));
const stop=entry.slice(entry.indexOf('function stopGeneration()'),entry.indexOf('// 幕外停止：'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
  let store={plan:{original:true}},context={chat:[]},account='st-user:a',calls=0,repairs=0,saves=0,injects=0,invocation;
  const gate=deferred(),sent=deferred();
  const c={busy:false,cancelRequested:false,abortController:null,directorRun:null,directorLiveLog:null,activeTab:'dashboard',MODAL_ID:'panel',
    settings:{enabled:true,providerMode:'external',streamEnabled:true,logHistory:[]},document:{getElementById:()=>null},AbortController,Date,console,
    validateApiSettings:()=>true,toast:()=>{},apiToast:()=>{},uid:()=>String(Math.random()),getChatStore:()=>store,getChatKey:()=>context.chatId||'one',ctx:()=>context,
    featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=>account})},renderBusyState:()=>{},buildPrompt:async()=>'fixture',DEFAULT_SYSTEM_PROMPT:'system',
    pushLog:log=>{c.settings.logHistory.push(log);return log;},saveSettings:()=>{},clone:structuredClone,normalizePlan:x=>x,parseDirectorFinal,
    directorDedupePlan:()=>[],repairDirectorPlanQuality:async()=>{repairs++;return {repaired:false,needs:{},removed:[],raw:'',error:''};},
    saveMetadata:async()=>saves++,applyDirectorInjection:async()=>injects++,refreshDirectorProductionPackets:async()=>{},injectSelection:new Set(),
    renderModal:()=>{},renderFloatButton:()=>{},rerenderIfOpen:()=>{},paintModelLog,renderDirectorLive,
    callExternalApi:async(messages,onDelta,cfg,controller)=>{calls++;invocation={messages,onDelta,cfg,controller};sent.resolve();return gate.promise;},
  };
  vm.createContext(c);vm.runInContext(source+'\n'+stop,c);
  return {c,gate,sent,run:()=>c.generateDirectorPlan(),get request(){return invocation;},get store(){return store;},get calls(){return calls;},get repairs(){return repairs;},get saves(){return saves;},get injects(){return injects;},
    switchChat(){store={plan:{other:true}};context={chat:[],chatId:'two'};},switchAccount(){account='st-user:b';}};
}

test('actual director streams into its own log, stages complete cards, and commits only the completed final object',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  const prefix='{"quests":[{"title":"first","objective":"complete card"}';
  e.request.onDelta(prefix);assert.equal(e.store.plan.original,true);assert.equal(e.saves,0);
  assert.match(renderDirectorLive(e.c.directorLiveLog),/complete card/);
  const raw=prefix+']}';e.request.cfg.onResponse({text:raw,reasoning:'separate thoughts',finishReason:'stop',complete:true});e.gate.resolve(raw);await run;
  assert.equal(e.store.plan.quests[0].title,'first');assert.equal(e.saves,1);assert.equal(e.injects,1);assert.equal(e.calls,1);
  const log=e.c.settings.logHistory[0];assert.equal(log.response,raw);assert.equal(log.reasoning,'separate thoughts');assert.equal(log.completion.finishReason,'stop');assert.equal(log.status,'success');
  assert.equal(e.c.busy,false);
});

test('actual truncation retains received cards and raw prose without repair requests, overwriting prior plan or injecting',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  const raw='{"quests":[{"title":"kept"},{"title":"partial';
  e.request.onDelta(raw);e.gate.reject(Object.assign(new Error('length limit'),{code:'MODEL_OUTPUT_INCOMPLETE',modelResponse:{text:raw,reasoning:'thought',finishReason:'length',complete:false,interrupted:true}}));await run;
  assert.equal(e.store.plan.original,true);assert.equal(e.repairs,0);assert.equal(e.saves,0);assert.equal(e.injects,0);
  const log=e.c.settings.logHistory[0];assert.equal(log.response,raw);assert.equal(log.status,'error');assert.equal(log.completion.finishReason,'length');assert.match(renderDirectorLive(log),/>kept</);assert.doesNotMatch(renderDirectorLive(log),/>partial</);
});

test('a syntactically unfinished final object is not repaired into successful adopted output',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;e.gate.resolve('{"quests":[{"title":"kept"}');await run;
  assert.equal(e.store.plan.original,true);assert.equal(e.repairs,0);assert.equal(e.c.settings.logHistory[0].status,'error');
});

for(const kind of ['chat','account','cancel'])test(`actual ${kind} change blocks late adoption and releases only its own request`,async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  if(kind==='chat')e.switchChat();else if(kind==='account')e.switchAccount();else{e.c.stopGeneration();assert.equal(e.c.busy,true);await e.run();assert.equal(e.calls,1);}
  e.gate.resolve('{"quests":[{"title":"late"}]}');await run;
  assert.equal(e.saves,0);assert.equal(e.injects,0);assert.equal(e.repairs,0);assert.ok(!e.store.plan.quests);assert.equal(e.c.busy,false);
});

test('late old finalizer cannot clear a replacement request admitted after runtime teardown',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  const next={controller:new AbortController()};e.c.directorRun=next;e.c.abortController=next.controller;e.c.busy=true;
  e.gate.resolve('{}');await run;assert.equal(e.c.directorRun,next);assert.equal(e.c.busy,true);assert.equal(e.c.abortController,next.controller);
});

test('editing model configuration mid-request cannot dispatch quality repair to a different provider',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  e.request.onDelta('{"quests":[');e.c.settings.providerMode='sillytavern';e.gate.resolve('{"quests":[]}');await run;
  assert.equal(e.repairs,0);assert.equal(e.saves,0);assert.equal(e.store.plan.original,true);
  assert.match(e.c.settings.logHistory[0].error,/模型配置已变更/);
});

test('host preview no longer listens to global token events and custom transport delegates raw decoding',()=>{
  const model=entry.slice(entry.indexOf('async function callExternalApi('),entry.indexOf('// 字符串感知'));
  assert.doesNotMatch(model,/STREAM_TOKEN_RECEIVED|source\.on|stream_token_received/);assert.match(model,/callHostChatModel/);assert.match(model,/callExternalModel/);
});
