import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createConfigUndoSlot} from '../qianmu-config-undo.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

test('both actual terminal pipeline writers require preservation and keep inline originals on collision',async()=>{
  for(const single of [false,true])for(const conflict of [false,true]) {
    const pipeline={id:'p',status:'success',stages:[{response:'full current text'}]},state={logs:[{pipelineId:'p'}],pipelineLogs:[pipeline]};
    let saved=0,seen;
    const c=vm.createContext({settings:state,configUndo:createConfigUndoSlot(),storyboardState:()=>state,storyboardPipelineArchiveEpoch:0,storyboardPipelineArchiveCache:new Map(),storyboardPipelineArchiveWrites:new Map(),
      clone:structuredClone,storyboardPackageArchiveAllowed:async()=>true,saveSettings:()=>saved++,console:{warn(){}},blobStore:{
        putStoryboardPipelineLogs:async(rows,options)=>{seen=options;assert.equal(rows[0].stages[0].response,'full current text');
          assert.notEqual(rows[0],pipeline);if(conflict)throw Error('collision');return {stored:['p']};}
      }});
    vm.runInContext(['storyboardPipelineIsTerminal','storyboardArchiveCompletedPipelines','storyboardArchivePipelineLog'].map(section).join('\n'),c);
    const task=single?c.storyboardArchivePipelineLog({pipelineId:'p'}):c.storyboardArchiveCompletedPipelines();
    if(conflict&&!single)await assert.rejects(task,/collision/);else await task;
    assert.equal(seen.preserveExisting,true);
    assert.equal(saved,conflict?0:1);assert.equal(state.pipelineLogs.length,conflict?1:0);
    if(conflict){assert.equal(state.pipelineLogs[0],pipeline);assert.equal(c.storyboardPipelineArchiveCache.size,0);}
  }
});
