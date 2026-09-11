import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createConfigUndoSlot} from '../qianmu-config-undo.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
function fixture() {
  const pipeline={id:'p',status:'success',stages:['old text']},state={logs:[{pipelineId:'p'}],pipelineLogs:[pipeline]},saves=[];
  const c=vm.createContext({settings:state,configUndo:createConfigUndoSlot(),storyboardPipelineArchiveEpoch:0,storyboardPipelineArchiveCache:new Map(),storyboardPipelineArchiveWrites:new Map(),storyboardPipelineArchiveHydration:null,
    clone:structuredClone,console:{warn(){}},activeTab:'other',storyboardPackageArchiveAllowed:async()=>true,saveSettings:()=>saves.push('save'),
    blobStore:{putStoryboardPipelineLogs:async()=>({stored:['p']}),getStoryboardPipelineLogs:async()=>[]}});
  c.storyboardState=()=>c.settings;
  vm.runInContext(['storyboardPipelineIsTerminal','storyboardArchiveCompletedPipelines','storyboardArchivePipelineLog','storyboardHydratePipelineArchive'].map(section).join('\n'),c);
  return {c,state,pipeline,saves};
}

test('old pipeline writes cannot strip inline data or cache into a restored owner, including edits during persistence',async()=>{
  for(const single of [false,true])for(const change of ['owner','epoch','edit']) {
    const e=fixture(),entered=deferred(),release=deferred();e.c.blobStore.putStoryboardPipelineLogs=async()=>{entered.resolve();await release.promise;};
    const task=single?e.c.storyboardArchivePipelineLog({pipelineId:'p'}):e.c.storyboardArchiveCompletedPipelines();await entered.promise;
    if(change==='owner')e.c.settings=structuredClone(e.state);else if(change==='epoch')e.c.storyboardPipelineArchiveEpoch++;else e.pipeline.stages.push('user edit');
    release.resolve();await task;
    assert.equal(e.state.pipelineLogs[0],e.pipeline);assert.equal(e.c.storyboardPipelineArchiveCache.size,0);
    assert.equal(e.saves.length,0);
  }
});

test('an old writer finishing cannot remove a newer task with the same pipeline id',async()=>{
  const e=fixture(),entered=deferred(),release=deferred();e.c.blobStore.putStoryboardPipelineLogs=async()=>{entered.resolve();await release.promise;};
  const running=e.c.storyboardArchivePipelineLog({pipelineId:'p'});await entered.promise;
  e.c.storyboardPipelineArchiveEpoch++;const newer=Promise.resolve('new');e.c.storyboardPipelineArchiveWrites.set('p',newer);
  release.resolve();await running;assert.equal(e.c.storyboardPipelineArchiveWrites.get('p'),newer);
});

test('stale hydration cannot populate a new cache or clear its successor promise',async()=>{
  const e=fixture(),entered=deferred(),release=deferred();e.state.pipelineLogs=[];
  e.c.blobStore.getStoryboardPipelineLogs=async()=>{entered.resolve();await release.promise;return [e.pipeline];};
  const running=e.c.storyboardHydratePipelineArchive();await entered.promise;
  e.c.settings=structuredClone(e.state);e.c.storyboardPipelineArchiveEpoch++;
  const newer=Promise.resolve('new');e.c.storyboardPipelineArchiveHydration=newer;
  release.resolve();assert.equal(await running,false);assert.equal(e.c.storyboardPipelineArchiveCache.size,0);assert.equal(e.c.storyboardPipelineArchiveHydration,newer);
});

test('verified pipeline shrinking retains the imported configuration undo point',async()=>{
  for(const single of [false,true]) {
    const e=fixture();assert.equal(e.c.configUndo.remember({settings:{theme:'before'},layoutBefore:null,layoutAfter:null},e.state),true);
    if(single)await e.c.storyboardArchivePipelineLog({pipelineId:'p'});else await e.c.storyboardArchiveCompletedPipelines();
    assert.equal(e.state.pipelineLogs.length,0);assert.equal(e.c.configUndo.available(e.state),true);
  }
});
