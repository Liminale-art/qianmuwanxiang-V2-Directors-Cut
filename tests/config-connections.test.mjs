import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as policy from '../qianmu-config-connections.js';
import {migrateTtsProviderSettingsState} from '../qianmu-tts-providers.js';
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
  const c=vm.createContext({...policy,settings:settings(),clone:structuredClone,isPlainObject:v=>v&&typeof v==='object'&&!Array.isArray(v),Blob,
    confirmDialog:async()=>false,normalizeStoryboardState:structuredClone,storyboardPlansForPortableExport:async value=>value,
    ttsDownloadBlob:(blob,name)=>downloads.push({blob,name}),toast:(...args)=>notices.push(args),fileStamp:()=> 'fixture',ctx:()=>context,MODULE_NAME:'module',DEFAULT_SETTINGS:{},
    mergeDefaults:()=>{},storyboardPlanArchiveEpoch:0,storyboardPlanArchiveTimer:null,storyboardPlanArchiveCache:new Map(),
    blobStore:{clearStoryboardPlanArchives(){throw Error('must never erase historical originals');}},
    getSettings:()=>context.extensionSettings.module,seedBuiltinTheaters(){},saveSettings:()=>writes.push('save'),storyboardSchedulePlanArchive(){},applyDirectorInjection:async()=>{},renderFloatButton(){},renderModal(){},cacheProseLayout(){}});
  vm.runInContext(section('exportConfig')+'\n'+section('importConfig'),c);
  return {c,downloads,notices,writes};
}

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
