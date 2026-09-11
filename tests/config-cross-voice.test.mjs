import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};

test('companion voice remains protected through dialog persistence and actual playback',async()=>{
  const saving=deferred(),playing=deferred(),entered=deferred(),msg={text:'hello',role:'friend'},person={avatar:'fixture'},btn={dataset:{},querySelector:()=>null};
  const c=vm.createContext({ttsRestoreTasks:0,coreadCompanionCharacter:()=>person,ctx:()=>({characters:[person],characterId:0}),
    setQianmuIconClass(){},toast(){},ttsSynthCached:async()=>({blob:{}}),coreadSaveDialog:async()=>{entered.resolve();await saving.promise;},
    refreshVoiceClipsIfVisible(){assert.equal(c.ttsRestoreTasks,1);},ttsPlayBlob:()=>playing.promise});
  vm.runInContext(section('coreadSpeakMsg'),c);
  const task=c.coreadSpeakMsg(msg,'friend',btn);await entered.promise;assert.equal(c.ttsRestoreTasks,1);
  saving.resolve();await Promise.resolve();assert.equal(c.ttsRestoreTasks,1);playing.resolve();await task;
  assert.equal(c.ttsRestoreTasks,0);assert.equal(msg.voiced,1);assert.equal(btn.dataset.speaking,undefined);
  await c.coreadSpeakMsg({text:''});assert.equal(c.ttsRestoreTasks,0);
  c.ttsSynthCached=async()=>{throw Error('fixture failure');};await c.coreadSpeakMsg(msg,'friend',btn,true);assert.equal(c.ttsRestoreTasks,0);
});

function directorFixture() {
  const editor={owner:{chatKey:'chat'},selections:[{clipId:'clip'}]},project={audio:{dialogue:[]}},calls=[];
  const line={lineId:'line',speaker:'friend',text:'hello',source:{refId:'ref'},startMs:0,endMs:1000};
  const c=vm.createContext({ttsRestoreTasks:0,storyboardFilmEditor:editor,storyboardCaptureFilmEditor(){},storyboardFilmPostproductionDraft:()=>project,
    featureRuntime:{load:async()=>({directorWorkOrderToVoiceLines:()=>[line]})},storyboardFilmClipTimings:()=>new Map([['clip',{startMs:0,endMs:1000}]]),
    storyboardFilmSourceRecordForSelection:()=>({id:'image'}),storyboardProductionContext:()=>({packetId:'packet'}),
    storyboardDirectorDecisionSnapshot:()=>({outputs:{voice:true},lanes:{dialogue:[{}]}}),storyboardDirectorWorkOrderForRecord:async()=>({}),
    ttsBuildParams:()=>({providerId:'fixture'}),ttsProviderHasCredentials:()=>true,getChatKey:()=> 'chat',ttsSynthCached:async()=>({params:{providerId:'fixture'}}),
    cacheKeyForTts:()=> 'fixture-asset',storyboardReconcileFilmPostproduction(){assert.equal(c.ttsRestoreTasks,1);calls.push('reconcile');},
    renderModal(){assert.equal(c.ttsRestoreTasks,1);calls.push('render');},toast(){},storyboardVideoOperationIssueLabel:()=> 'fixture'});
  vm.runInContext(section('storyboardGenerateDirectorVoice'),c);return {c,editor,project,calls};
}

test('director synthesis protects scene selection through audio-track updates and releases on early exit',async()=>{
  const e=directorFixture(),entered=deferred(),release=deferred(),button={isConnected:true,disabled:false};
  e.c.storyboardDirectorWorkOrderForRecord=async()=>{entered.resolve();await release.promise;return {};};
  const task=e.c.storyboardGenerateDirectorVoice({},button);await entered.promise;assert.equal(e.c.ttsRestoreTasks,1);
  release.resolve();await task;assert.equal(e.c.ttsRestoreTasks,0);assert.equal(button.disabled,false);assert.equal(e.project.audio.dialogue.length,1);
  assert.deepEqual(e.calls,['reconcile','render']);e.c.storyboardFilmEditor=null;await e.c.storyboardGenerateDirectorVoice({},button);assert.equal(e.c.ttsRestoreTasks,0);
});

test('a switched film editor cannot receive the old synthesis result after its await',async()=>{
  const e=directorFixture();e.c.ttsSynthCached=async()=>{e.c.storyboardFilmEditor={};return {params:{providerId:'fixture'}};};
  await e.c.storyboardGenerateDirectorVoice({},null);
  assert.equal(e.project.audio.dialogue.length,0);assert.deepEqual(e.calls,[]);assert.equal(e.c.ttsRestoreTasks,0);
});
