import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {logFixture} from './helpers/storyboard-log-fixture.mjs';
const entry=readFileSync(new URL('../index.js',import.meta.url),'utf8');

// The NAI inbox is retired. Receipt/account/archive guarantees remain in
// config-service-receive and image-service-recovery; no old UI is recreated here.
test('NAI original receipt states never expose a retired inbox or capacity/catalog UI',()=>{
  const {state,context}=logFixture();
  for(const [status,submissionState] of [['failed','unknown'],['failed','accepted'],['success','accepted']]){
    state.logs=[{id:'nai-original',source:'novel',status,submissionState,params:{},
      snapshot:{serviceTask:{attemptId:'nai-original'}},error:status==='failed'?'Original diagnostic':''}];
    const html=context.renderStoryboardLogs(state);
    assert.match(html,/data-storyboard-log="nai-original"/);
    assert.doesNotMatch(html,/NAI 收片|sd-storyboard-service-inbox|data-service-(?:scope|review|receive)-|存储详情|等待预留|核查原请求/);
  }
  assert.doesNotMatch(section('renderStoryboardLogs'),/\.catalog\(|\.list\(|storyboardReceiveServiceImage\(/);
});

test('NAI inbox bindings are gone while guarded original-attempt recovery remains available',()=>{
  assert.doesNotMatch(entry,/storyboardPaintServiceInbox|storyboardReviewServiceImage|sd-storyboard-open-service-inbox|data-service-receive-index/);
  const recover=section('storyboardRecoverOriginalTasks');
  assert.match(recover,/state\.logs\.includes\(log\)/);
  assert.match(recover,/storyboardReceiveServiceImage\(snapshot\.serviceTask\.attemptId,null,snapshot\.imageAdmission\.namespace,\{silent:true,valid\}\)/);
  assert.doesNotMatch(recover,/\.catalog\(|\.list\(|\.submit\(|storyboardGenerate|storyboardRetryLog/);
  const receive=section('storyboardReceiveServiceImage');
  assert.match(receive,/expectedNamespace/);
  assert.match(receive,/valid/);
});
