import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { parseDirectorFinal, renderDirectorLive, paintModelLog, renderModelDiagnostics, modelFailureText, directorPreviewPlan, directorQualitySummary } from '../qianmu-director-live.js';
import { normalizeCreativeSections, validateCreativePlan, pruneInvalidCreativeItems } from '../qianmu-creative-contract.js';
import { isPlainObject, mergeDefaults } from '../qianmu-storyboard-utils.js';
import { captureCurrentChatSource } from '../qianmu-current-chat-source.js';
import { createDirectorLeaveGuard } from '../qianmu-director-leave-guard.js';
import { captureDirectorSaveSnapshot } from '../qianmu-director-save-confirmation.js';
import { directorHostFixture } from './helpers/director-host-fixture.mjs';
const entry=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
const source=entry.slice(entry.indexOf('function makeStreamLogUpdater('),entry.indexOf('// MIGRATED to qianmu-storyboard-utils.js (commit 19)'));
const normalizeSource=entry.slice(entry.indexOf('function normalizePlan('),entry.indexOf('// directorItemText -'));
const qualitySource=entry.slice(entry.indexOf('function directorDedupePlan('),entry.indexOf('function makeStreamLogUpdater('));
const stop=entry.slice(entry.indexOf('function stopGeneration()'),entry.indexOf('// 幕外停止：'));
const saveInputSource=entry.slice(entry.indexOf('function directorPendingSave('),entry.indexOf('// Rerolls at the saved floor'));
const busyStart=entry.indexOf('function renderBusyState()');
const busySource=entry.slice(busyStart,entry.indexOf('// 折叠面板开合状态记忆',busyStart));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const closeClick=()=>{
  const close={closest:selector=>selector==='#options'?{}:null};
  return {type:'click',button:0,target:{closest:selector=>selector==='#option_close_chat'?close:null},prevented:false,stopped:false,
    preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};
};
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

function fixture({ saveHook, confirmHook, captureHook, hostOverrides }={}){
  let store={plan:{original:true}},context={chat:[],chatId:'one',characterId:0,characters:[{chat:'one',avatar:'fixture.png'}],chatMetadata:{},saveMetadata:async()=>{},getRequestHeaders:()=>({})},account='st-user:a',calls=0,repairs=0,saves=0,injects=0,invocation;
  context.chatMetadata.story_director_liminale=store;
  const notices=[],saveStages=[],listeners=new Map(),button={disabled:false,innerHTML:'',classList:{toggle(){}}};let releases=0;
  const gate=deferred(),sent=deferred();
  let closes=0;
  const host=directorHostFixture({closeCurrentChat:async()=>{closes++;return true;},...hostOverrides});
  const c={worldCompletions:[],busy:false,cancelRequested:false,abortController:null,directorRun:null,directorLiveLog:null,activeTab:'dashboard',MODAL_ID:'panel',
    settings:{enabled:true,providerMode:'external',streamEnabled:true,logHistory:[]},document:{getElementById:()=>null,querySelectorAll:selector=>selector==='.sd-generate-main'?[button]:[],addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:(type,fn)=>{if(listeners.get(type)===fn)listeners.delete(type);}},AbortController,Date,console,
    directorLeaveGuard:null,directorHostState:host.state,directorAutoRefresh:null,directorUnconfirmedSaves:new WeakMap(),captureCurrentChatSource,
    createDirectorLeaveGuard:options=>{const owner=createDirectorLeaveGuard(options);return {...owner,finish:async(...args)=>{releases++;return await owner.finish(...args);}};},
    captureDirectorSaveSnapshot:options=>{saveStages.push('capture');return captureHook?captureHook(options):captureDirectorSaveSnapshot(options);},
    confirmDirectorSave:async(snapshot,options)=>{saveStages.push('confirm');await options.guard();if(confirmHook)return await confirmHook({c,context,store,snapshot,options});return {status:'confirmed'};},
    validateApiSettings:()=>true,toast:(...args)=>notices.push(args),apiToast:()=>{},uid:()=>String(Math.random()),getChatStore:()=>store,getChatKey:()=>context.chatId||'one',ctx:()=>context,
    featureRuntime:{load:async()=>({resolveImageAccountNamespace:async()=>account})},applyQianmuIcons:()=>{},theaterBusy:false,buildPrompt:async run=>{run.creativeOptions=creativeOptions;run.sourceFingerprint='fixture-source';return 'fixture';},directorSourceFingerprint:()=>'fixture-source',DEFAULT_SYSTEM_PROMPT:'system',
    resolveImageAccountNamespace:async()=>account,storyboardState:()=>({enabled:true,directorBridge:{worldSideShotsEnabled:true}}),
    pushLog:log=>{c.settings.logHistory.push(log);return log;},saveSettings:()=>{},clone:structuredClone,parseDirectorFinal,
    isPlainObject,mergeDefaults,normalizeCreativeSections,validateCreativePlan,pruneInvalidCreativeItems,directorPreviewPlan,directorQualitySummary,
    repairDirectorPlanQuality:async()=>{repairs++;return {repaired:false,needs:{},removed:[],raw:'',error:''};},
    saveMetadata:async()=>{saves++;saveStages.push('save');await saveHook?.({c,context,store});},applyDirectorInjection:async()=>{injects++;saveStages.push('inject');},clearDirectorInjection:()=>{},refreshDirectorProductionPackets:async()=>{},injectSelection:new Set(),resetCreativeSocialState:()=>{},
    storyboardQueueNewWorldPlan:async(plan,owner)=>{assert.equal(saves,1);assert.equal(injects,1);assert.equal(plan,store.plan);assert.equal(owner.store,store);assert.equal(owner.namespace,account);c.worldCompletions.push({plan,owner});},
    renderModal:()=>{},renderFloatButton:()=>{},rerenderIfOpen:()=>{},paintModelLog,renderDirectorLive,
    callExternalApi:async(messages,onDelta,cfg,controller)=>{calls++;invocation={messages,onDelta,cfg,controller};sent.resolve();return gate.promise;},
  };
  vm.createContext(c);vm.runInContext(normalizeSource+'\n'+qualitySource+'\n'+saveInputSource+'\n'+source+'\n'+stop+'\n'+busySource,c);
  return {c,gate,sent,saveStages,notices,listeners,button,host,run:()=>c.generateDirectorPlan(),get closes(){return closes;},get releases(){return releases;},get context(){return context;},get request(){return invocation;},get store(){return store;},get calls(){return calls;},get repairs(){return repairs;},get saves(){return saves;},get injects(){return injects;},
    switchChat(){store={plan:{other:true}};context={chat:[],chatId:'two',characterId:0,characters:[{chat:'two',avatar:'fixture.png'}],chatMetadata:{story_director_liminale:store},saveMetadata:async()=>{}};},switchAccount(){account='st-user:b';}};
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

test('slow native save holds the saving phase, disables stop and verifies before injection or storyboard work',async()=>{
  const hostGate=deferred(),hostStarted=deferred(),confirmationGate=deferred(),confirmationStarted=deferred();
  const e=fixture({saveHook:()=>{hostStarted.resolve();return hostGate.promise;},confirmHook:async()=>{confirmationStarted.resolve();await confirmationGate.promise;return {status:'confirmed'};}});
  const run=e.run();await e.sent.promise;const raw=JSON.stringify(completePlan());e.gate.resolve(raw);await hostStarted.promise;
  const owned=e.c.directorRun;
  assert.equal(owned.phase,'saving');assert.equal(e.button.disabled,true);assert.match(e.button.innerHTML,/正在保存/);
  assert.equal(e.saves,1);assert.equal(e.injects,0);assert.equal(e.c.worldCompletions.length,0);
  e.c.stopGeneration();assert.equal(owned.controller.signal.aborted,false);assert.equal(e.c.cancelRequested,false);
  assert.match(e.notices.at(-1)[0],/正在保存/);assert.equal(e.c.settings.logHistory[0].saveState,'saving');
  const duringSave=closeClick();e.listeners.get('click')(duringSave);
  assert.equal(duringSave.prevented,true);assert.equal(duringSave.stopped,true);assert.equal(owned.controller.signal.aborted,false);
  await e.run();assert.equal(e.calls,1,'a second generation is not admitted while persistence is pending');
  hostGate.resolve();await confirmationStarted.promise;
  assert.equal(e.injects,0);assert.equal(e.c.worldCompletions.length,0);assert.equal(e.c.directorPendingSave(e.store)?.previousValues.get('plan').value.original,true);
  confirmationGate.resolve();await run;
  assert.deepEqual(e.saveStages,['capture','save','confirm','inject']);assert.equal(e.injects,1);assert.equal(e.c.worldCompletions.length,0,'closing does not enqueue new world-side image work');
  assert.equal(e.closes,1,'one remembered close runs after confirmation without another click');
  assert.equal(e.c.settings.logHistory[0].saveState,'confirmed');assert.equal(e.c.directorPendingSave(e.store),null);
  assert.equal(e.releases,1);assert.equal(owned.source.isCurrent(),false);assert.equal(e.c.busy,false);
  assert.equal(e.button.disabled,false);assert.match(e.button.innerHTML,/推演下一幕/);
  const afterSave=closeClick();e.listeners.get('click')(afterSave);assert.equal(afterSave.prevented,false);assert.equal(afterSave.stopped,false);
});

test('ordinary close during generation cancels before host submission while allowing the navigation',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  const event=closeClick();e.listeners.get('click')(event);
  assert.equal(event.prevented,false);assert.equal(event.stopped,false);assert.equal(e.request.controller.signal.aborted,true);
  e.gate.resolve(JSON.stringify(completePlan()));await run;
  assert.equal(e.saves,0);assert.equal(e.injects,0);assert.equal(e.store.plan.original,true);
  assert.equal(e.releases,1);assert.equal(e.c.settings.logHistory[0].status,'cancelled');
});

for(const phase of ['generating','saving','stream-tail'])test(`mainline ${phase} denies manual Q admission even when prose text has not changed`,async()=>{
  const overrides=phase==='generating'?{isGenerating:()=>true}:phase==='saving'?{isChatSaving:true}:{streamingProcessor:{isFinished:true,isStopped:false}};
  const e=fixture({hostOverrides:overrides});await e.host.state.ready();await e.run();
  assert.equal(e.calls,0);assert.equal(e.saves,0);assert.equal(e.store.plan.original,true);
  assert.equal(e.c.busy,false);assert.match(e.notices.at(-1)[0],/正文正在生成或保存/);
});

test('unknown official host capability fails closed before sending a paid request or touching the plan',async()=>{
  const e=fixture({hostOverrides:{isGenerating:undefined}});await e.run();
  assert.equal(e.calls,0);assert.equal(e.saves,0);assert.equal(e.store.plan.original,true);
  assert.equal(e.c.busy,false);assert.equal(e.c.settings.logHistory[0].errorCode,'DIRECTOR_HOST_UNAVAILABLE');
});

test('mainline start immediately aborts a waiting Q request without waiting for a new prose token',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  e.c.directorMainlineStarted('normal',{},false);
  assert.equal(e.request.controller.signal.aborted,true);
  e.gate.resolve(JSON.stringify(completePlan()));await run;
  assert.equal(e.saves,0);assert.equal(e.injects,0);assert.equal(e.store.plan.original,true);
  assert.match(e.c.settings.logHistory[0].error,/正文开始生成/);
});

test('a new mainline start cancels an older queued automatic trigger even before host busy flags or a Q run exist',()=>{
  const e=fixture();let cancellations=0;e.c.directorAutoRefresh={cancel(){cancellations++;}};
  assert.equal(e.c.directorRun,null);
  e.c.directorMainlineStarted('quiet',{},false);e.c.directorMainlineStarted('normal',{},true);
  assert.equal(cancellations,0);
  e.c.directorMainlineStarted('normal',{},false);
  assert.equal(cancellations,1);assert.equal(e.calls,0);
});

test('dry run and quiet helpers do not cancel Q; quiet-to-loud visible generation does',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;
  e.c.directorMainlineStarted('normal',{},true);
  e.c.directorMainlineStarted('quiet',{},false);
  assert.equal(e.request.controller.signal.aborted,false);
  e.c.directorMainlineStarted('quiet',{quietToLoud:true},false);
  assert.equal(e.request.controller.signal.aborted,true);
  e.gate.resolve('{}');await run;assert.equal(e.saves,0);
});

test('host flags alone catch a missed start event before adopting temporarily unchanged prose',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;e.host.module.isGenerating=()=>true;
  e.gate.resolve(JSON.stringify(completePlan()));await run;
  assert.equal(e.saves,0);assert.equal(e.injects,0);assert.equal(e.store.plan.original,true);
  assert.equal(e.c.settings.logHistory[0].errorCode,'DIRECTOR_HOST_BUSY');
});

test('host-refused close does not first cancel Q or consume a queued automatic trigger',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;let cancelled=0;
  e.c.directorAutoRefresh={cancel(){cancelled++;}};e.host.module.isGenerating=()=>true;
  const event=closeClick();e.listeners.get('click')(event);
  assert.equal(event.prevented,false);assert.equal(e.request.controller.signal.aborted,false);assert.equal(cancelled,0);
  e.gate.resolve(JSON.stringify(completePlan()));await run;assert.equal(e.saves,0);
});

test('generation close cancels pending automatic work and never saves the incomplete candidate',async()=>{
  const e=fixture(),run=e.run();await e.sent.promise;let cancelled=0;
  e.c.directorAutoRefresh={cancel(){cancelled++;}};
  e.listeners.get('click')(closeClick());
  assert.equal(cancelled,1);assert.equal(e.request.controller.signal.aborted,true);
  e.gate.resolve(JSON.stringify(completePlan()));await run;assert.equal(e.saves,0);
});

test('remembered close stays protected through native asynchronous close and suppresses further world jobs',async()=>{
  const save=deferred(),saved=deferred(),closing=deferred(),closed=deferred();let nativeCloses=0,autoCancels=0;
  const e=fixture({saveHook:()=>{saved.resolve();return save.promise;},hostOverrides:{closeCurrentChat:async()=>{nativeCloses++;closing.resolve();return closed.promise;}}});
  const run=e.run();await e.sent.promise;e.gate.resolve(JSON.stringify(completePlan()));await saved.promise;
  e.c.directorAutoRefresh={cancel(){autoCancels++;}};
  for(let i=0;i<3;i++)e.listeners.get('click')(closeClick());
  assert.equal(autoCancels,1);assert.equal(nativeCloses,0);assert.equal(e.saves,1);
  save.resolve();await closing.promise;
  assert.equal(e.c.busy,true);assert.equal(e.c.directorRun.source.isCurrent(),true);
  const again=closeClick();e.listeners.get('click')(again);assert.equal(again.prevented,true);
  await e.run();assert.equal(e.calls,1);
  closed.resolve(true);await run;
  assert.equal(nativeCloses,1);assert.equal(e.c.worldCompletions.length,0);assert.equal(e.c.busy,false);
});

for(const cause of ['unconfirmed','host-started','source-changed'])test(`queued close is discarded on ${cause} without retry or rollback`,async()=>{
  const save=deferred(),saved=deferred();
  const e=fixture({saveHook:()=>{saved.resolve();return save.promise;},confirmHook:cause==='unconfirmed'?()=>{throw Error('unconfirmed');}:undefined});
  const run=e.run();await e.sent.promise;e.gate.resolve(JSON.stringify(completePlan()));await saved.promise;
  const store=e.store;e.listeners.get('click')(closeClick());
  if(cause==='host-started'){
    e.c.directorMainlineStarted('normal',{},false);
    assert.equal(e.request.controller.signal.aborted,false,'native writer is allowed to finish');
  }else if(cause==='source-changed')e.switchChat();
  save.resolve();await run;
  assert.equal(e.closes,0);assert.equal(e.saves,1);assert.equal(e.injects,0);
  assert.equal(store.plan.quests[0].title,'first','unknown write must not restore stale data');
  assert.equal(e.c.busy,false);
});

test('native close refusal preserves the successful save and does not create a retry',async()=>{
  const save=deferred(),saved=deferred();let closes=0;
  const e=fixture({saveHook:()=>{saved.resolve();return save.promise;},hostOverrides:{closeCurrentChat:async()=>{closes++;return false;}}});
  const run=e.run();await e.sent.promise;e.gate.resolve(JSON.stringify(completePlan()));await saved.promise;
  e.listeners.get('click')(closeClick());save.resolve();await run;
  assert.equal(closes,1);assert.equal(e.saves,1);assert.equal(e.c.settings.logHistory[0].saveState,'confirmed');
  assert.ok(e.notices.some(([text])=>/未能自动关闭/.test(text)));assert.equal(e.c.busy,false);
});

for(const failure of ['host-rejection','readback-mismatch','readback-timeout'])test(`invoked save ${failure} preserves the candidate and response without rollback, retry or downstream admission`,async()=>{
  const error=Object.assign(new Error(failure),{code:'DIRECTOR_SAVE_UNCONFIRMED'});
  const e=fixture(failure==='host-rejection'?{saveHook:()=>{throw error;}}:{confirmHook:()=>{throw error;}});
  const run=e.run();await e.sent.promise;const raw=JSON.stringify(completePlan());e.gate.resolve(raw);await run;
  assert.equal(e.store.plan.quests[0].title,'first');assert.equal(e.saves,1);assert.equal(e.injects,0);assert.equal(e.calls,1);
  assert.equal(e.c.worldCompletions.length,0);assert.equal(e.releases,1);assert.equal(e.c.busy,false);
  const log=e.c.settings.logHistory[0];assert.equal(log.saveState,'unconfirmed');assert.notEqual(log.resultSaved,true);
  assert.equal(log.response,raw);assert.equal(log.errorCode,'DIRECTOR_SAVE_UNCONFIRMED');assert.equal(log.errorCause,failure);
  assert.equal(e.c.directorInputStore(e.store).plan.original,true);assert.ok(e.c.directorPendingSave(e.store));
  assert.equal(e.saveStages.filter(stage=>stage==='save').length,1);
  assert.equal(e.saveStages.includes('confirm'),failure!=='host-rejection','undefined host resolution is not itself a save confirmation');
});

test('snapshot preflight rejection does not invoke the native save and releases the protection after restoring owned staging',async()=>{
  const e=fixture({captureHook:()=>{throw new Error('SNAPSHOT_NOT_AVAILABLE');}}),original=e.store.plan;
  const run=e.run();await e.sent.promise;const raw=JSON.stringify(completePlan());e.gate.resolve(raw);await run;
  assert.equal(e.store.plan,original);assert.equal(e.saves,0);assert.equal(e.injects,0);assert.equal(e.c.worldCompletions.length,0);
  assert.equal(e.releases,1);assert.equal(e.c.busy,false);assert.equal(e.c.directorPendingSave(e.store),null);
  assert.equal(e.c.settings.logHistory[0].saveState,'not_submitted');assert.equal(e.c.settings.logHistory[0].response,raw);
});

test('a non-UI source replacement during an invoked save cannot inject into the replacement chat or roll back the old candidate',async()=>{
  const hostGate=deferred(),hostStarted=deferred();
  const e=fixture({saveHook:()=>{hostStarted.resolve();return hostGate.promise;}}),original=e.store;
  const run=e.run();await e.sent.promise;e.gate.resolve(JSON.stringify(completePlan()));await hostStarted.promise;
  const oldRun=e.c.directorRun;e.switchChat();hostGate.resolve();await run;
  assert.equal(e.store.plan.other,true);assert.equal(original.plan.quests[0].title,'first');
  assert.equal(e.saves,1);assert.equal(e.injects,0);assert.equal(e.c.worldCompletions.length,0);
  assert.equal(e.c.settings.logHistory[0].saveState,'unconfirmed');assert.ok(e.c.directorPendingSave(original));
  assert.equal(e.c.directorPendingSave(e.store),null);assert.equal(e.releases,1);assert.equal(oldRun.source.isCurrent(),false);
});
