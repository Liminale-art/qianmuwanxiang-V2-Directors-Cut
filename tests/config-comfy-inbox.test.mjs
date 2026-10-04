import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {logFixture} from './helpers/storyboard-log-fixture.mjs';

const source=readFileSync(new URL('../index.js',import.meta.url),'utf8');
// Inbox retired; receipt/ownership guarantees remain tested by the receive suites.
test('empty and populated logs never render receipt inboxes or original-task review buttons',()=>{
  const {state,context:c}=logFixture();
  for(const status of [null,'failed','success','generating']){
    state.logs=status?[{id:'original',status,submissionState:'accepted',source:'comfy',comfyReceipt:true,snapshot:{serviceTask:{attemptId:'original'}}}]:[];
    assert.doesNotMatch(c.renderStoryboardLogs(state),/NAI 收片|Comfy 收片|领取原图|核查原请求|sd-storyboard-(?:comfy|service)-inbox/);
  }
});
test('retired Comfy inbox is not dynamically loaded or mounted by the production entry',()=>{
  assert.doesNotMatch(source,/comfyInbox\s*:|import\(['"]\.\/qianmu-comfy-inbox-view|mountComfyInbox/);
});
test('retired frontend callbacks and inbox cleanup bindings cannot retain a stale page owner',()=>{
  assert.doesNotMatch(source,/storyboardOpenComfyInbox|storyboardPaintServiceInbox|storyboardReviewServiceImage|_sdComfyInboxCleanup/);
  assert.doesNotMatch(source,/sd-storyboard-open-service-inbox|sd-storyboard-open-comfy-inbox|sd-storyboard-receive-comfy/);
});
test('automatic recovery uses the exact original attempt and guarded save, never a catalog or submission',()=>{
  const recovery=section('storyboardRecoverOriginalTasks');
  assert.match(recovery,/state\.logs\.includes\(log\)/);
  assert.match(recovery,/storyboardReceiveComfyImage\(log,\{refresh:false,silent:true,valid\}\)/);
  assert.match(recovery,/storyboardReceiveServiceImage\(snapshot\.serviceTask\.attemptId,null,snapshot\.imageAdmission\.namespace,\{silent:true,valid\}\)/);
  assert.doesNotMatch(recovery,/\.catalog\(|\.submit\(|storyboardGenerate|storyboardRetryLog|prepareCloudSubmission/);
});
test('log rendering stays read only and does not trigger original recovery',()=>{
  assert.doesNotMatch(section('renderStoryboardLogs'),/storyboardRecoverOriginalTasks|storyboardReceiveComfyImage\(|storyboardReceiveServiceImage\(/);
  assert.match(section('storyboardHandleChatChanged'),/storyboardRecoverOriginalTasks\(\)/);
});
test('resource packages live only in Data Management, never mixed into gallery or logs',()=>{
  const gallery=section('renderStoryboardGallery'),logs=section('renderStoryboardLogs');
  assert.doesNotMatch(gallery,/sd-storyboard-pack-|sd-storyboard-gallery-resources/);
  assert.doesNotMatch(logs,/sd-storyboard-pack-|资源联包|不包含 API Key/);
  const bindings=section('bindStorageManagementEvents');
  assert.match(bindings,/storyboard:\(\)=>storyboardExportPackage\(\{bundle:true\}\)/);
  assert.match(bindings,/storyboard:storyboardImportAnyPackage/);
  assert.match(bindings,/sd-storage-storyboard-recover[\s\S]*storyboardImportPackage\(null, \{ recoverOnly: true \}\)/);
});
