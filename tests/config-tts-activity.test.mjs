import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {configRestoreGate} from '../qianmu-config-connections.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(extra={}) {
  const c=vm.createContext({ttsRestoreTasks:0,settings:{},setQianmuIconClass(){},toast(){},...extra});
  vm.runInContext(['ttsHandleTrigger','ttsHandlePlayAll','ttsSynthCached'].map(section).join('\n'),c);
  return c;
}
test('preparation and post-extraction NPC persistence remain inside one protected operation',async()=>{
  const prep=deferred(),extract=deferred(),bar={dataset:{},innerHTML:''},mes={querySelectorAll:()=>[]};let c,applied=0;
  const notices=[];
  c=fixture({ttsEnsureBar:()=>bar,ttsPrepareLineStore:()=>prep.promise,ttsRawText:()=> 'text',ttsContentKey:()=> 'key',
    ttsLineCache:new Map(),ttsPersistedLines:()=>null,ttsMigrateLinesOnEdit:()=>null,ttsCleanText:x=>x,extractDialogue:()=>extract.promise,
    ttsStoreLines(){assert.equal(c.ttsRestoreTasks,1);},ttsMesId:()=> 'mes',ttsAssignNpc:()=>true,saveSettings(){assert.equal(c.ttsRestoreTasks,1);},
    ttsApplyLines(){applied++;assert.equal(c.ttsRestoreTasks,1);},applyQianmuIcons(){},htmlEscape:x=>x});
  const gate=configRestoreGate(c.settings,()=>({voice:c.ttsRestoreTasks>0}),(...args)=>notices.push(args));
  const task=c.ttsHandleTrigger({closest:()=>mes,querySelector:()=>null});assert.equal(gate(c.settings),false);
  prep.resolve();await Promise.resolve();assert.equal(gate(c.settings),false);extract.resolve([{text:'line'}]);await task;
  assert.equal(applied,1);assert.equal(c.ttsRestoreTasks,0);assert.equal(gate(c.settings),true);assert.match(notices[0][0],/配音/);
});
test('concurrent syntheses stay protected until model persistence and cache pruning complete',async()=>{
  const synth=deferred(),write=deferred(),prune=deferred();let c;
  c=fixture({ttsBuildParams:()=>({providerId:'doubao',model:'auto'}),getTtsProvider:()=>({label:'fixture'}),ttsProviderHasCredentials:()=>true,cacheKeyForTts:()=> 'key',
    synthesizeTts:()=>synth.promise,ttsPersistResolvedDoubaoModel(){assert.ok(c.ttsRestoreTasks>0);},
    blobStore:{blobStoreAvailable:()=>true,putAudio:()=>write.promise,pruneAudio:()=>prune.promise}});
  const tasks=[c.ttsSynthCached({speaker:'a'},true),c.ttsSynthCached({speaker:'b'},true)];assert.equal(c.ttsRestoreTasks,2);
  synth.resolve({blob:{},resolvedModel:'resolved'});await Promise.resolve();assert.equal(c.ttsRestoreTasks,2);
  write.resolve();await Promise.resolve();assert.equal(c.ttsRestoreTasks,2);prune.resolve();await Promise.all(tasks);assert.equal(c.ttsRestoreTasks,0);
});
test('early returns and synchronous exceptions always release counters',async()=>{
  const c=fixture({TTS_BAR_CLASS:'bar',ttsBuildParams:()=>null});
  await c.ttsHandleTrigger({closest:()=>null});assert.equal(c.ttsRestoreTasks,0);
  await c.ttsHandlePlayAll({closest:()=>null});assert.equal(c.ttsRestoreTasks,0);
  await assert.rejects(c.ttsSynthCached({speaker:'a'}));assert.equal(c.ttsRestoreTasks,0);
  await assert.rejects(c.ttsHandleTrigger(null));assert.equal(c.ttsRestoreTasks,0);
});
test('sequential playback stays protected through its final asynchronous playback and cleanup',async()=>{
  const playback=deferred(),bar={dataset:{key:'key'},querySelectorAll:()=>[{dataset:{idx:'0'}}]},mes={querySelector:()=>bar};let c,cleaned=false;
  c=fixture({TTS_BAR_CLASS:'bar',ttsSeqToken:0,ttsStopPlayback(){},ttsSetPlayingState(){},ttsLineCache:new Map([['key',[{text:'line'}]]]),
    ttsPlayBlob:()=>playback.promise,ttsHighlightEls:()=>[],ttsAutoRestore(){assert.equal(c.ttsRestoreTasks,1);cleaned=true;}});
  c.ttsSynthCached=async()=>({blob:{}});
  const task=c.ttsHandlePlayAll({closest:()=>mes},true);await Promise.resolve();assert.equal(c.ttsRestoreTasks,1);
  playback.resolve();await task;assert.equal(c.ttsRestoreTasks,0);assert.equal(cleaned,true);
});
