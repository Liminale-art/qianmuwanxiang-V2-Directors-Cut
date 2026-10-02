import vm from 'node:vm';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';
import {createStoryboardCompilerInterruptionRecorder} from '../../qianmu-storyboard-compiler-diagnostics.js';
export function installCompilerDiagnosticsFixture(context) {
  // These request/diagnostic tests isolate reference IO. Dedicated worldbook
  // integration tests install the real controller and host adapter instead.
  context.storyboardPrepareWorldContext ||= async()=>{};
  context.createStoryboardCompilerInterruptionRecorder=createStoryboardCompilerInterruptionRecorder;
  context.resolveImageAccountNamespace||=async()=> 'st-user:compiler-diagnostic-fixture';
  context.storyboardAdmissionEpoch??=0;
  context.storyboardPipelineArchiveCache=new Map();
  context.blobStore={...context.blobStore,deleteStoryboardPipelineLogs:async()=>{}};
  context.storyboardArchivePipelineLog=async()=>{};
  vm.runInContext(section('storyboardStoreLog'),context);
}
