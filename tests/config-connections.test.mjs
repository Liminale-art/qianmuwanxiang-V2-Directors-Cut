import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as policy from '../qianmu-config-connections.js';
import {finishConfigRestore} from '../qianmu-config-apply.js';
import {exportConfiguration} from '../qianmu-config-export.js';
import {createConfigUndoSlot} from '../qianmu-config-undo.js';
import {createConfigUndoAction} from '../qianmu-config-undo-action.js';
import {migrateTtsProviderSettingsState} from '../qianmu-tts-providers.js';
import {mergeDefaults} from '../qianmu-storyboard-utils.js';
import * as utilities from '../qianmu-storyboard-utils.js';
import * as ttsProviders from '../qianmu-tts-providers.js';
import {normalizeQianmuStructuredOutputMode} from '../qianmu-llm-output.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

function settings(prefix='source') {
  const key=prefix+'-credential', api={apiUrl:prefix+'/api',apiKey:key,model:'m'};
  return {...api,apiProfiles:[{id:'api',...api}],theme:'dark',tts:{apiKey:key,provider:'doubao',extractApiProfileId:'api',
    providers:{doubao:{apiKey:key,appId:prefix,accessKey:key,endpoint:prefix,model:'speech',voiceLibrary:[{voiceId:'voice',model:'voice-model'}]},minimax:{apiKey:key}}},
    coread:{books:[{id:'book',progress:.5}],memory:{summaryApiKey:key,summaryProfiles:[api],vectorApiKey:key,vectorProfiles:[api],rerankApiKey:key,rerankProfiles:[api],dictBooks:[{id:'dictionary',name:'apiKey'}]}},
    imagegen:{connections:{comfy:{draft:{baseUrl:prefix,headers:{Authorization:key}},presets:[{credentialId:prefix}]}},profiles:{comfy:{comfyUrl:prefix}},shotPlans:[{id:'old-shot',prompt:'unchanged'}]},
    focusClock:{dialogueLibrary:{rows:[{id:'line',text:'keep all words',moments:['focus:complete']}]}}};
}

test('excluding APIs removes nested provider and memory connections, not voices, text or book progress',()=>{
  const original=settings(),snapshot=structuredClone(original);policy.omitConfigConnections(snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot),/source-credential|Authorization|credentialId|summaryProfiles/);
  assert.equal(snapshot.tts.providers.doubao.voiceLibrary[0].model,'voice-model');
  assert.deepEqual(snapshot.focusClock,original.focusClock);assert.deepEqual(snapshot.coread.books,original.coread.books);
  assert.deepEqual(snapshot.imagegen.shotPlans,original.imagegen.shotPlans);assert.equal(original.tts.providers.doubao.apiKey,'source-credential');
});

test('excluded imports preserve recipient connections without moving their credentials to foreign voices or mutating live settings',()=>{
  const current=settings('target'),incoming=policy.omitConfigConnections(settings());incoming.tts.providers.doubao.voiceLibrary=[{voiceId:'new'}];
  const before=structuredClone(current);policy.restoreConfigConnections(incoming,current);
  assert.equal(incoming.tts.providers.doubao.apiKey,'target-credential');assert.equal(incoming.coread.memory.vectorApiKey,'target-credential');
  assert.deepEqual(incoming.imagegen.connections,current.imagegen.connections);assert.deepEqual(incoming.tts.providers.doubao.voiceLibrary,[{voiceId:'new'}]);
  incoming.imagegen.connections.comfy.draft.baseUrl='changed';assert.deepEqual(current,before);
});

test('old excluded packs cannot sneak nested API fields back in and absent target connections stay absent',()=>{
  const pack={version:1,type:'qianmu-config',includeApi:false,settings:settings()};
  const read=policy.readConfigEnvelope(pack);assert.equal(read.preserveConnections,true);
  policy.restoreConfigConnections(read.settings,{theme:'light'});assert.doesNotMatch(JSON.stringify(read.settings),/source-credential|Authorization/);
  assert.deepEqual(read.settings.coread.books,[{id:'book',progress:.5}]);
});

test('legacy TTS migration after an excluded import preserves recipient credentials while migrating the source voice library',()=>{
  const current={tts:migrateTtsProviderSettingsState({apiKey:'recipient-key',endpoint:'https://recipient.invalid',model:'speech-2.8-hd',voiceLibrary:[]})};
  const incoming={tts:{apiKey:'legacy-source-key',endpoint:'https://source.invalid',voiceLibrary:[{id:'legacy',voiceId:'old-voice'}]}};
  policy.restoreConfigConnections(incoming,current);migrateTtsProviderSettingsState(incoming.tts);
  assert.equal(incoming.tts.providers.minimax.apiKey,'recipient-key');assert.equal(incoming.tts.providers.minimax.endpoint,'https://recipient.invalid');
  assert.equal(incoming.tts.providers.minimax.voiceLibrary[0].voiceId,'old-voice');assert.doesNotMatch(JSON.stringify(incoming),/legacy-source-key|source\.invalid/);
});

test('supported envelopes retain explicit included APIs; malformed or unsafe data never reaches merging',()=>{
  for(const version of [1,2])assert.equal(policy.readConfigEnvelope({version,type:'qianmu-config',includeApi:true,settings:settings()}).preserveConnections,false);
  assert.equal(policy.readConfigEnvelope({version:2,type:'qianmu-config',includeApi:true,settings:{tts:{providers:{doubao:{apiKey:'explicit'}}}}}).preserveConnections,false);
  assert.equal(policy.readConfigEnvelope({version:1,type:'qianmu-config',settings:{theme:'dark'}}).preserveConnections,true);
  assert.throws(()=>policy.readConfigEnvelope({version:2,type:'qianmu-config',settings:{theme:'dark'}}));
  for(const bad of [{version:3,type:'qianmu-config',settings:{}},{version:2,type:'qianmu-config',settings:[]},{version:2,type:'qianmu-config',includeApi:'false',settings:{}},JSON.parse('{"version":1,"type":"qianmu-config","settings":{"deep":{"__proto__":{"unsafe":true}}}}')])assert.throws(()=>policy.readConfigEnvelope(bad));
  assert.equal({}.unsafe,undefined);
});

function fixture() {
  const downloads=[],notices=[],writes=[],context={extensionSettings:{}};
  const c=vm.createContext({...policy,exportConfiguration,finishConfigRestore,configUndo:createConfigUndoSlot(),configUndoAction:null,createConfigUndoAction,PROSE_LAYOUT_STORAGE_KEY:'fixture-layout',settings:settings(),clone:structuredClone,isPlainObject:v=>v&&typeof v==='object'&&!Array.isArray(v),Blob,
    confirmDialog:async()=>false,configRestoreActivity:()=>({}),normalizeStoryboardState:structuredClone,storyboardPlansForPortableExport:async value=>value,
    ttsDownloadBlob:(blob,name)=>downloads.push({blob,name}),toast:(...args)=>notices.push(args),fileStamp:()=> 'fixture',ctx:()=>context,MODULE_NAME:'module',DEFAULT_SETTINGS:{},
    mergeDefaults:()=>{},migrateSettings:()=>{},storyboardPlanArchiveEpoch:0,storyboardPlanArchiveTimer:null,storyboardPlanArchiveCache:new Map(),
    blobStore:{clearStoryboardPlanArchives(){throw Error('must never erase historical originals');}},
    getSettings:()=>context.extensionSettings.module,seedBuiltinTheaters(){},saveSettings:()=>writes.push('save'),storyboardSchedulePlanArchive(){},applyDirectorInjection:async()=>{},renderFloatButton(){},renderModal(){},cacheProseLayout(){}});
  vm.runInContext(['exportConfig','importConfig','configApplyOptions','undoConfigRestore'].map(section).join('\n'),c);
  return {c,downloads,notices,writes};
}

function realMigrationFixture() {
  const e=fixture();Object.assign(e.c,utilities,ttsProviders,{normalizeQianmuStructuredOutputMode,
    DEFAULT_SETTINGS:{tts:{}},DEFAULT_SYSTEM_PROMPT:'fixture system',JSON_SCHEMA_TEXT:'{}',PROMPT_REVISION:1,LOG_LIMIT:10});
  // Production functions live in an ES module: match its strict assignment semantics.
  vm.runInContext('"use strict";\n'+section('migrateTtsProviderSettings')+'\n'+section('migrateSettings'),e.c);
  return e;
}

test('real settings migration rejects malformed nested input before touching live configuration or originals',async()=>{
  for(const incoming of [{templates:[null]},{templates:[{} ,null]},{contextOptions:'invalid'}]){
    const e=realMigrationFixture(),owner=e.c.settings;let cacheWrites=0;e.c.cacheProseLayout=()=>cacheWrites++;e.c.confirmDialog=async()=>true;
    const pack={version:2,type:'qianmu-config',includeApi:false,settings:{...incoming,proseLayout:{width:10}}};
    await e.c.importConfig({target:{files:[{text:async()=>JSON.stringify(pack)}],value:'selected'}});
    assert.equal(e.c.settings,owner);assert.equal(e.c.ctx().extensionSettings.module,undefined);assert.equal(e.writes.length,0);
    assert.equal(cacheWrites,0);assert.equal(e.c.storyboardPlanArchiveEpoch,0);assert.equal(e.notices.at(-1)[0],'配置无法恢复，当前设置未改变。');
  }
});

test('real migration preserves legacy voice content and cannot refill excluded credentials on a later read',async()=>{
  const e=realMigrationFixture();e.c.settings=settings('target');e.c.confirmDialog=async()=>true;
  const incoming={ttsSettings:{apiKey:'legacy-secret',voiceLibrary:[{id:'voice',voiceId:'legacy-voice'}]},templates:[{name:'old',tags:['folder'],content:'keep'}]};
  const pack={version:1,type:'qianmu-config',includeApi:false,settings:incoming};
  await e.c.importConfig({target:{files:[{text:async()=>JSON.stringify(pack)}],value:'selected'}});
  assert.equal(e.writes.length,1);assert.equal(e.c.settings.apiKey,'target-credential');
  assert.equal(e.c.settings.tts.providers.doubao.apiKey,'target-credential');assert.equal(e.c.settings.tts.providers.minimax.voiceLibrary[0].voiceId,'legacy-voice');
  assert.equal(e.c.settings.templates[0].folder,'folder');assert.equal(e.c.settings.templates[0].content,'keep');
  e.c.migrateSettings(e.c.settings);
  assert.doesNotMatch(JSON.stringify(e.c.settings),/legacy-secret/);assert.equal(e.c.settings.tts.providers.doubao.apiKey,'target-credential');
});

test('restore confirmation explains replacement and original boundaries without exposing imported content',()=>{
  const incoming=settings();incoming.coread.books[0].title='<img src=x onerror=secret>';const before=structuredClone(incoming);
  const preview=policy.configRestoreSummary(incoming,true);
  assert.match(preview,/不会自动合并/);assert.match(preview,/1 项书目索引/);assert.match(preview,/不表示书籍正文已备份/);
  assert.match(preview,/不会随此配置包恢复或清空/);assert.match(preview,/当前连接与密钥保留/);
  assert.doesNotMatch(preview,/onerror|secret|source-credential/);assert.deepEqual(incoming,before);
  assert.match(policy.configRestoreSummary({},false),/当前书架索引可能被重置/);
  assert.match(policy.configRestoreSummary({},false),/连接与密钥也将/);
});

test('restore guard rejects replaced or mutated settings and fails closed on uninspectable data',()=>{
  const owner=settings(),valid=policy.configRestoreGuard(owner);assert.equal(valid(owner),true);
  assert.equal(valid(structuredClone(owner)),false);owner.coread.books[0].progress=.75;assert.equal(valid(owner),false);
  const circular={};circular.self=circular;assert.equal(policy.configRestoreGuard(circular)(circular),false);
  assert.equal(policy.configRestoreGuard(undefined)(undefined),false);
});

test('restore preparation is detached, recursively fills defaults and strips only local archive references',()=>{
  const incoming=settings(),current=settings('target'),before=structuredClone(incoming),local=structuredClone(current);
  Object.assign(incoming.imagegen.shotPlans[0],{archiveRef:'device-only',archiveVersion:1,archivedAt:12});
  const result=policy.prepareConfigRestore(incoming,current,{coread:{enabled:false,books:[]}},true,{clone:structuredClone,mergeDefaults,normalizeStoryboardState:structuredClone});
  assert.equal(result.coread.enabled,false);assert.deepEqual(result.coread.books,before.coread.books);
  assert.equal(result.apiKey,'target-credential');assert.equal(result.imagegen.shotPlans[0].prompt,'unchanged');
  for(const field of ['archiveRef','archiveVersion','archivedAt'])assert.equal(Object.hasOwn(result.imagegen.shotPlans[0],field),false);
  assert.equal(incoming.imagegen.shotPlans[0].archiveRef,'device-only');assert.deepEqual(current,local);
  assert.throws(()=>policy.prepareConfigRestore(incoming,current,{},true,{clone:structuredClone,mergeDefaults,normalizeStoryboardState:()=>{throw Error('prepare failed');}}),/prepare failed/);
  assert.deepEqual(current,local);assert.equal(incoming.imagegen.shotPlans[0].archiveRef,'device-only');
});

test('legacy connection aliases are excluded and cannot refill foreign keys after migration',()=>{
  for(const alias of ['directorSettings','director','ttsSettings','speechSettings','theaterSettings','theaters']){
    const value=alias.includes('director')?{apiUrl:'legacy-secret',apiKey:'legacy-secret',theme:'light'}
      : ['ttsSettings','speechSettings'].includes(alias)?{apiKey:'legacy-secret',providers:{doubao:{apiKey:'legacy-secret',voiceLibrary:[{voiceId:'kept'}]}}}
      : {apiProfileId:'legacy-secret',scripts:[{title:'kept'}]};
    const pack={[alias]:value,apiPresets:[{apiKey:'legacy-secret'}]},before=structuredClone(pack);
    const exported=policy.omitConfigConnections(structuredClone(pack));assert.doesNotMatch(JSON.stringify(exported),/legacy-secret/);assert.deepEqual(pack,before);
    const restored=policy.prepareConfigRestore(pack,settings('target'),{},true,{clone:structuredClone,mergeDefaults,normalizeStoryboardState:structuredClone,
      migrateSettings:s=>{if(s.tts)migrateTtsProviderSettingsState(s.tts);}});
    assert.doesNotMatch(JSON.stringify(restored),/legacy-secret/);assert.equal(restored.apiKey,'target-credential');
    if(alias.includes('director'))assert.equal(restored.theme,'light');
  }
});

test('actual import migration failure returns before replacing host settings or touching prose and archives',async()=>{
  const e=fixture(),owner=e.c.settings;e.c.confirmDialog=async()=>true;
  e.c.migrateSettings=()=>{throw Error('synthetic migration failure');};
  e.c.cacheProseLayout=()=>{throw Error('cache must not be touched');};
  const file={text:async()=>JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:{proseLayout:{width:10}}})};
  await e.c.importConfig({target:{files:[file],value:'x'}});
  assert.equal(e.c.settings,owner);assert.equal(e.c.ctx().extensionSettings.module,undefined);assert.equal(e.c.storyboardPlanArchiveEpoch,0);assert.equal(e.writes.length,0);
  assert.equal(e.notices.at(-1)[0],'配置无法恢复，当前设置未改变。');
});
test('actual oversized config import neither reads the file nor confirms or saves',async()=>{
  const e=fixture(),owner=e.c.settings;let read=false,confirm=false;
  e.c.confirmDialog=async()=>{confirm=true;return true;};
  await e.c.importConfig({target:{value:'selected',files:[{size:policy.CONFIG_INPUT_LIMITS.bytes+1,text:async()=>{read=true;return '{}';}}]}});
  assert.equal(read,false);assert.equal(confirm,false);assert.equal(e.c.settings,owner);assert.equal(e.writes.length,0);assert.match(e.notices[0][0],/32 MiB/);
});

test('catalog preparation failure never publishes imported settings or saves partial configuration',async()=>{
  const e=fixture(),owner=e.c.settings;e.c.confirmDialog=async()=>true;
  e.c.seedBuiltinTheaters=prepared=>{assert.notEqual(prepared,owner);throw Error('synthetic catalog error');};
  e.c.cacheProseLayout=()=>{throw Error('cache must not be touched');};
  await e.c.importConfig({target:{files:[{text:async()=>JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:{proseLayout:{width:10}}})}],value:'x'}});
  assert.equal(e.c.settings,owner);assert.equal(e.c.ctx().extensionSettings.module,undefined);
  assert.equal(e.writes.length,0);assert.equal(e.c.storyboardPlanArchiveEpoch,0);
  assert.equal(e.notices.at(-1)[0],'配置无法恢复，当前设置未改变。');
});

test('restore gate reports active work without cancelling it and accepts only idle unchanged state',()=>{
  const owner=settings(),notices=[],state={};const gate=policy.configRestoreGate(owner,()=>state,(...args)=>notices.push(args));
  assert.equal(gate(owner),true);
  for(const key of ['reader','focus','director','image','transfer']){state[key]=true;assert.equal(gate(owner),false);assert.equal(state[key],true);delete state[key];}
  assert.equal(notices.length,5);assert.equal(gate(owner),true);
});

test('actual import checks active work before file reading and again after confirmation',async()=>{
  for(const phase of ['before','confirm']){
    const e=fixture(),owner=e.c.settings;let active=phase==='before',reads=0;
    e.c.configRestoreActivity=()=>({image:active});e.c.confirmDialog=async()=>{active=true;return true;};
    const file={text:async()=>{reads++;return JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:settings()});}};
    await e.c.importConfig({target:{files:[file],value:'x'}});
    assert.equal(reads,phase==='before'?0:1);assert.equal(e.c.settings,owner);assert.equal(e.writes.length,0);assert.equal(e.c.storyboardPlanArchiveEpoch,0);
    assert.match(e.notices.at(-1)[0],/等待分镜/);
  }
});

test('actual activity adapter blocks each independent lane without normalizing or changing settings',()=>{
  const lanes={
    voice:['ttsRestoreTasks'],
    reader:['readerView','coreadMemoryWrites','coreadIdentitySwitchBusy','coreadWorldSyncBusy','coreadDistilling','coreadAutoTextInFlight','dialogBusy','readerAssistantBusy','coreadComicVisionBusy'],
    focus:['focusClockEntryBusy'],director:['busy','theaterBusy'],image:['storyboardBusy','storyboardCompilerBusy','storyboardAutomaticCurrent'],
  };
  const base=Object.fromEntries(Object.values(lanes).flat().map(key=>[key,false]));
  const c=vm.createContext({...base,settings:{focusClock:{status:'idle'}},focusClockVoicePreparation:null,
    storyboardActiveJobs:new Map(),storyboardGenerationPreparing:new Set(),storyboardQueue:[],storyboardAutomaticPending:new Map(),
    storyboardImportPackage:{},storyboardExportPackage:{},storyboardBundleReview:null});
  vm.runInContext(section('configRestoreActivity'),c);
  const idle=()=>assert.equal(Object.values(c.configRestoreActivity()).some(Boolean),false);
  idle();const before=JSON.stringify(c.settings);let cases=0;
  for(const [lane,keys] of Object.entries(lanes))for(const key of keys){c[key]=true;assert.ok(c.configRestoreActivity()[lane],key);c[key]=false;idle();cases++;}
  for(const [key,value,lane] of [['storyboardActiveJobs',new Map([['job',{}]]),'image'],['storyboardGenerationPreparing',new Set(['job']),'image'],
    ['storyboardQueue',[{}],'image'],['storyboardAutomaticPending',new Map([['floor',{}]]),'image'],['focusClockVoicePreparation',{busy:true},'focus'],
    ['storyboardImportPackage',{busy:true},'transfer'],['storyboardExportPackage',{busy:true},'transfer'],['storyboardBundleReview',{isOpen:true},'transfer']]){
    const previous=c[key];c[key]=value;assert.ok(c.configRestoreActivity()[lane],key);c[key]=previous;idle();cases++;
  }
  for(const status of ['running','paused']){c.settings.focusClock.status=status;assert.ok(c.configRestoreActivity().focus,status);cases++;}
  c.settings.focusClock.status='idle';idle();assert.equal(JSON.stringify(c.settings),before);assert.equal(cases,26);
});

test('actual import preserves same-owner changes made during file reading or confirmation',async()=>{
  for(const phase of ['read','confirm']){
    const e=fixture(),owner=e.c.settings;let resume,shown=0;
    const wait=()=>new Promise(r=>resume=r);
    e.c.confirmDialog=phase==='confirm'?wait:async()=>{shown++;return true;};
    const payload=JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:{coread:{books:[]}}});
    const pending=e.c.importConfig({target:{value:'selected',files:[{text:phase==='read'?wait:async()=>payload}]}});
    await new Promise(r=>setImmediate(r));owner.coread.books[0].progress=.75;resume(phase==='read'?payload:true);await pending;
    assert.equal(e.c.settings,owner);assert.equal(owner.coread.books[0].progress,.75);assert.equal(e.writes.length,0);
    assert.equal(e.c.storyboardPlanArchiveEpoch,0);assert.equal(shown,0);
    assert.equal(e.notices.at(-1)[0],'设置已变化，请重新导入。');
  }
});

test('actual export produces a versioned settings-only pack without reading secrets or changing saved connections',async()=>{
  const e=fixture(),before=structuredClone(e.c.settings);await e.c.exportConfig();
  const pack=JSON.parse(await e.downloads[0].blob.text());assert.equal(pack.version,2);assert.equal(pack.includeApi,false);
  assert.doesNotMatch(JSON.stringify(pack),/source-credential/);assert.deepEqual(e.c.settings,before);
});

test('actual excluded import preserves local API paths and does not clear archive originals',async()=>{
  const e=fixture();e.c.settings=settings('target');e.c.confirmDialog=async()=>true;
  const file={text:async()=>JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:settings()})};
  await e.c.importConfig({target:{files:[file],value:'selected'}});
  assert.equal(e.c.settings.apiKey,'target-credential');assert.equal(e.c.settings.tts.providers.doubao.apiKey,'target-credential');assert.equal(e.writes.length,1);
});

test('actual import restores settings and raw layout after save failure without invalidating archives',async()=>{
  const e=fixture(),owner=e.c.settings;let cache='raw old cache',saves=0;e.c.confirmDialog=async()=>true;
  e.c.localStorage={getItem:()=>cache,setItem:(k,v)=>{cache=v;},removeItem:()=>{cache=null;}};
  e.c.saveSettings=()=>{if(++saves===1)throw Error('synthetic save failure');};
  await e.c.importConfig({target:{files:[{text:async()=>JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:{proseLayout:{width:99}}})}],value:'x'}});
  assert.equal(e.c.settings,owner);assert.equal(e.c.ctx().extensionSettings.module,undefined);assert.equal(cache,'raw old cache');assert.equal(saves,2);
  assert.equal(e.c.storyboardPlanArchiveEpoch,0);assert.match(e.notices.at(-1)[0],/当前页面已恢复原配置.*保存结果未确认/);
});

test('view errors after a successful import warn without rolling back or resubmitting configuration',async()=>{
  const e=fixture();e.c.confirmDialog=async()=>true;e.c.renderModal=()=>{throw Error('synthetic render failure');};
  await e.c.importConfig({target:{files:[{text:async()=>JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:{theme:'new'}})}],value:'x'}});
  assert.equal(e.c.settings.theme,'new');assert.equal(e.writes.length,1);assert.equal(e.c.storyboardPlanArchiveEpoch,1);
  assert.match(e.notices.at(-1)[0],/配置已应用，但页面更新未完成/);assert.equal(e.notices.at(-1)[1],'warning');
});

test('a delayed injection never renders or announces the old import over a new settings owner',async()=>{
  const e=fixture();e.c.confirmDialog=async()=>true;let release,rendered=0;
  e.c.applyDirectorInjection=()=>new Promise(r=>release=r);e.c.renderModal=()=>rendered++;
  const pending=e.c.importConfig({target:{files:[{text:async()=>JSON.stringify({version:2,type:'qianmu-config',includeApi:false,settings:{theme:'new'}})}],value:'x'}});
  await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');const other=settings('other');e.c.settings=other;release();await pending;
  assert.equal(e.c.settings,other);assert.equal(rendered,0);assert.equal(e.writes.length,1);assert.equal(e.notices.length,0);
});

test('cancelled import and late confirmations or archive reads do not export/import another settings owner',async()=>{
  for(const mode of ['cancel','read','confirm','export-confirm','export-archive']) {
    const e=fixture();let resume;const wait=()=>new Promise(r=>resume=r);const next=settings('new');
    const payload=JSON.stringify({version:1,type:'qianmu-config',includeApi:true,settings:settings()});
    if(mode==='confirm'||mode==='export-confirm')e.c.confirmDialog=wait;
    if(mode==='export-archive')e.c.storyboardPlansForPortableExport=wait;
    const pending=mode.startsWith('export')?e.c.exportConfig():e.c.importConfig({target:{files:[{text:mode==='read'?wait:async()=>payload}],value:'x'}});
    if(mode!=='cancel'){await new Promise(r=>setImmediate(r));e.c.settings=next;resume(mode==='read'?payload:mode==='export-archive'?[]:true);}
    await pending;assert.equal(e.downloads.length,0,mode);assert.equal(e.writes.length,0,mode);
  }
});
