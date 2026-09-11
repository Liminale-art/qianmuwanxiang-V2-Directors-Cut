import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {preserveCapturedPlanArchives} from '../qianmu-plan-archive-write.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const captured=()=>[{key:'chat␟plan',chatKey:'chat',id:'plan',updatedAt:1,status:'completed',plan:{shots:[{prompt:'kept'}]}}];

test('archive bridge requires preservation and returns committed variant without mutating captured payload',async()=>{
  const captures=captured(),before=structuredClone(captures),key=captures[0].key+'␟revision:'+'a'.repeat(64);
  const stored=await preserveCapturedPlanArchives(captures,async(rows,options)=>{
    assert.equal(options.preserveExisting,true);assert.equal(rows[0].planId,'plan');rows[0].plan.shots[0].prompt='copy changed';return {stored:[key]};
  });
  assert.equal(stored[0].key,key);assert.deepEqual(captures,before);assert.equal(stored[0].plan.shots[0].prompt,'kept');
});

test('missing, extra or unrelated returned keys fail closed instead of discarding heavy data',async()=>{
  for(const result of [null,{}, {stored:[]},{stored:['']},{stored:['wrong-owner']},{stored:['chat␟plan','extra']},{stored:['chat␟plan␟revision:bad']}]){
    const captures=captured(),before=structuredClone(captures);
    await assert.rejects(preserveCapturedPlanArchives(captures,async()=>result),/归档返回位置不完整/);assert.deepEqual(captures,before);
  }
});

test('actual archive callback preserves heavy settings on failed mapping or changed epoch',async()=>{
  for(const mode of ['invalid','stale','valid']){
    const plan={id:'plan',chatKey:'chat',status:'completed',updatedAt:1,shots:[{id:'s',prompt:'kept',status:'completed'}]},state={shotPlans:[plan]};let saved=0;
    const key='chat␟plan␟revision:'+'a'.repeat(64);
    const c=vm.createContext({clone:structuredClone,preserveCapturedPlanArchives,storyboardState:()=>state,storyboardPlanArchiveEpoch:0,storyboardPlanArchiveCache:new Map(),saveSettings(){saved++;},console:{warn(){}},storyboardPackageArchiveAllowed:async()=>true});
    c.blobStore={blobStoreAvailable:()=>true,putStoryboardPlanArchives:async()=>{if(mode==='stale')c.storyboardPlanArchiveEpoch++;return mode==='invalid'?{stored:[]}:{stored:[key]};}};
    vm.runInContext('"use strict";\n'+['storyboardPlanIsTerminal','storyboardPlanArchiveKey','storyboardPlanHasHeavyPayload','storyboardPlanArchivePayload','storyboardPlanLightweightSummary','storyboardArchiveShotPlans'].map(section).join('\n'),c);
    assert.equal(await c.storyboardArchiveShotPlans(),mode==='valid'?1:0);
    if(mode==='valid'){assert.equal(state.shotPlans[0].archiveRef,key);assert.equal(c.storyboardPlanArchiveCache.get(key).shots[0].prompt,'kept');assert.equal(saved,1);}
    else{assert.equal(state.shotPlans[0],plan);assert.equal(plan.shots[0].prompt,'kept');assert.equal(saved,0);assert.equal(c.storyboardPlanArchiveCache.size,0);}
  }
});
