import vm from 'node:vm';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';
export function installCompilerDiagnosticsFixture(context) {
  context.storyboardPipelineArchiveCache=new Map();
  context.blobStore={...context.blobStore,deleteStoryboardPipelineLogs:async()=>{}};
  context.storyboardArchivePipelineLog=async()=>{};
  vm.runInContext(section('storyboardStoreLog'),context);
}
