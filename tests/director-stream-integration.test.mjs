import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseDirectorFinal, renderDirectorLive, paintModelLog, renderModelDiagnostics, modelFailureText, directorPreviewPlan, directorQualitySummary } from '../qianmu-director-live.js';
import { normalizeCreativeSections, validateCreativePlan, pruneInvalidCreativeItems } from '../qianmu-creative-contract.js';
import { isPlainObject, mergeDefaults } from '../qianmu-storyboard-utils.js';
const entry=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
const source=entry.slice(entry.indexOf('function makeStreamLogUpdater('),entry.indexOf('// MIGRATED to qianmu-storyboard-utils.js (commit 19)'));
const normalizeSource=entry.slice(entry.indexOf('function normalizePlan('),entry.indexOf('// directorItemText -'));
const qualitySource=entry.slice(entry.indexOf('function directorDedupePlan('),entry.indexOf('function makeStreamLogUpdater('));
const stop=entry.slice(entry.indexOf('function stopGeneration()'),entry.indexOf('// 幕外停止：'));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const creativeOptions=Object.freeze({parallelSceneEnabled:false,interludeEnabled:false});
function completePlan(){
  return {quests:Array.from({length:5},(_,i)=>({title:i?'offer '+i:'first',subject:'visitor',description:i?'a visitor brings letter '+i:'complete card'})),
    story_status:{directions:[{horizon:'near',title:'New routes',content:'The delivery dispute changes the regional routes.'},{horizon:'far',title:'Old debts',content:'The accounts bring a different generation into the dispute.'}]},
    character_dynamics:Array.from({length:2},(_,i)=>({title:'moment '+i,content:'the character attends to letter '+i})),
    npc_updates:Array.from({length:3},(_,i)=>({name:'neighbor '+i,next_action:'collect delivery '+i})),
    chain_reactions:Array.from({length:3},(_,i)=>({spark:'road '+i+' closes',chain:'delivery '+i+' takes the longer route → suppliers postpone arrivals → shops change their opening hours'})),
    relation_undercurrents:Array.from({length:3},(_,i)=>({parties:i===2?['neighbor '+i,'shopkeeper '+i,'dispatcher '+i]:['neighbor '+i,'shopkeeper '+i],tension:'unreturned letter '+i+' keeps the promise open'}))};
}

test('director parser repairs fenced JSON with a missing property comma without a second model call', () => {
  const malformed = '```json\n{"story_status":{"title":"街角"} "quests":[{"title":"门口"}]}\n```';
  const parsed = parseDirectorFinal(malformed);
  assert.equal(parsed.story_status.title, '街角');
  assert.deepEqual(parsed.quests, [{ title: '门口' }]);
});

test('director parser keeps genuinely invalid output as a JSON failure', () => {
  assert.throws(() => parseDirectorFinal('{"story_status":'), /JSON_PARSE_FAILED::/);
});

function fixture(){
  let store={plan:{original:true}},context={chat:[]},account='st-user:a',calls=0,repairs=0,saves=0,injects=0,invocation;
  const gate=deferred(),sent=deferred();
  const c={worldCompletions:[],busy:false,cancelRequested:false,abortController:null,directorRun:null,directorLiveLog:null,activeTab:'dashboard',MODAL_ID:'panel',
    settings:{enabled:true,providerMode:'external',streamEnabled:true,logHistory:[]},document:{getElementById:()=>null},AbortController,Date,console,
    validateApiSettings:()=>true,toast:()=>{},apiToast:()=>{},uid:()=>String(Math.random()),getChatStore:()=>store,getChatKey:()=>context.chatId||'one',ctx:()=>context,
    featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=>account})},renderBusyState:()=>{},buildPrompt:async run=>{run.creativeOptions=creativeOptions;run.sourceFingerprint='fixture-source';return 'fixture';},directorSourceFingerprint:()=>'fixture-source',DEFAULT_SYSTEM_PROMPT:'system',
    resolveImageAccountNamespace:async()=>account,storyboardState:()=>({enabled:true,directorBridge:{worldSideShotsEnabled:true}}),
    pushLog:log=>{c.settings.logHistory.push(log);return log;},saveSettings:()=>{},clone:structuredClone,parseDirectorFinal,
    isPlainObject,mergeDefaults,normalizeCreativeSections,validateCreativePlan,pruneInvalidCreativeItems,directorPreviewPlan,directorQualitySummary,
    repairDirectorPlanQuality:async()=>{repairs++;return {repaired:false,needs:{},removed:[],raw:'',error:''};},
    saveMetadata:async()=>saves++,applyDirectorInjection:async()=>injects++,refreshDirectorProductionPackets:async()=>{},injectSelection:new Set(),resetCreativeSocialState:()=>{},
    storyboardQueueNewWorldPlan:async(plan,owner)=>{assert.equal(saves,1);assert.equal(injects,1);assert.equal(plan,store.plan);assert.equal(owner.store,store);assert.equal(owner.namespace,account);c.worldCompletions.push({plan,owner});},
    renderModal:()=>{},renderFloatButton:()=>{},rerenderIfOpen:()=>{},paintModelLog,renderDirectorLive,
    callExternalApi:async(messages,onDelta,cfg,controller)=>{calls++;invocation={messages,onDelta,cfg,controller};sent.resolve();return gate.promise;},
  };
  vm.createContext(c);vm.runInContext(normalizeSource+'\n'+qualitySource+'\n'+source+'\n'+stop,c);
  return {c,gate,sent,run:()=>c.generateDirectorPlan(),get request(){return invocation;},get store(){return store;},get calls(){return calls;},get repairs(){return repairs;},get saves(){return saves;},get injects(){return injects;},
    switchChat(){store={plan:{other:true}};context={chat:[],chatId:'two'};},switchAccount(){account='st-user:b';}};
}

test('actual director streams into its own log, stages complete cards, and commits only the completed final object',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  const full=completePlan(),raw=JSON.stringify(full),prefix=raw.slice(0,raw.indexOf('},{')+1);
  e.request.onDelta(prefix);assert.equal(e.store.plan.original,true);assert.equal(e.saves,0);
  assert.match(renderDirectorLive(e.c.directorLiveLog),/complete card/);
  e.request.cfg.onResponse({text:raw,reasoning:'separate thoughts',finishReason:'stop',complete:true});e.gate.resolve(raw);await run;
  assert.equal(e.store.plan.quests[0].title,'first');assert.equal(e.saves,1);assert.equal(e.injects,1);assert.equal(e.calls,1);
  assert.equal(e.c.worldCompletions.length,1);
  const log=e.c.settings.logHistory[0];assert.equal(log.response,raw);assert.equal(log.reasoning,'separate thoughts');assert.equal(log.completion.finishReason,'stop');assert.equal(log.status,'success');
  assert.equal(e.c.busy,false);
});

test('actual creative-shortfall failure log renders named missing sections from its runtime quality object',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  const plan=completePlan();plan.character_dynamics=[];
  e.gate.resolve(JSON.stringify(plan));await run;
  const log=e.c.settings.logHistory[0];
  assert.equal(log.status,'error');assert.ok(Array.isArray(log.quality.issues));
  assert.equal(log.quality.gaps.character_dynamics,2);
  assert.match(modelFailureText(log),/此间一人缺 2 条/);
  assert.equal(e.saves,0);assert.equal(e.injects,0);assert.equal(e.store.plan.original,true);
});

test('actual truncation retains received cards and raw prose without repair requests, overwriting prior plan or injecting',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  const raw='{"quests":[{"title":"kept"},{"title":"partial';
  e.request.onDelta(raw);e.gate.reject(Object.assign(new Error('length limit'),{code:'MODEL_OUTPUT_INCOMPLETE',modelResponse:{text:raw,reasoning:'thought',finishReason:'length',complete:false,interrupted:true}}));await run;
  assert.equal(e.store.plan.original,true);assert.equal(e.repairs,0);assert.equal(e.saves,0);assert.equal(e.injects,0);
  assert.equal(e.c.worldCompletions.length,0);
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
  assert.equal(e.c.worldCompletions.length,0);
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
