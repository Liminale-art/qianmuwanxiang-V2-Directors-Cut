import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorldPromptAttempt} from '../qianmu-world-prompt-diagnostics.js';
import * as core from '../qianmu-storyboard.js';
import {logFixture} from './helpers/storyboard-log-fixture.mjs';
const input={messages:[{role:'user',content:'one world image'}],formats:['tags'],schema:{type:'object'},schemaId:'world',maxTokens:1000};
function fixture(call,extra={}){let seq=0,time=100;return createWorldPromptAttempt({call,guard:()=>{},uid:p=>p+'-'+(++seq),sanitize:core.sanitizeStoryboardDiagnosticData,startedAt:90,model:'chosen',now:()=>++time,...extra});}

test('world requests keep real usage, completion and parse failures without admitting image tasks',async()=>{
  let calls=0;const a=fixture(async(_m,profile,options)=>{calls++;assert.equal(profile,'selected');assert.equal(typeof options.guard,'function');
    options.onResponse({text:'bad output',finishReason:'stop',complete:true,usage:{total_tokens:17,apiKey:'hidden'},reasoning:'hidden reasoning'});return 'bad output';});
  await assert.rejects(a.request(input,'selected',()=>{throw Object.assign(Error('invalid format'),{code:'world_shot_preparation'});},{repairAttempt:2}),{code:'world_shot_preparation'});
  const {log,pipeline}=a.failure(Error('format exhausted'));assert.equal(calls,1);assert.equal(log.kind,'prompt_compiler');assert.equal(log.promptOrigin,'world');assert.equal(log.snapshot,null);
  assert.equal(log.submissionState,'not_submitted');assert.equal(log.floor,null);
  const row=pipeline.stages[0];assert.equal(row.status,'failed');assert.equal(row.input.repairAttempt,2);assert.equal(row.output.response.text,'bad output');
  assert.equal(row.output.response.usage.total_tokens,17);assert.equal(row.output.response.complete,true);
  assert.doesNotMatch(JSON.stringify(pipeline),/hidden reasoning|apiKey/);
});
test('world transport failure retains actual partial response, sanitizes secrets and does not retry',async()=>{
  let calls=0;const a=fixture(async(_m,_p,o)=>{calls++;o.onResponse({text:'partial',finishReason:'length',complete:false,interrupted:true,receivedBytes:7,usage:{input_tokens:10,output_tokens:2}});
    throw Object.assign(Error('HTTP 429 Authorization: Bearer world-secret'),{code:'MODEL_OUTPUT_INCOMPLETE'});});
  await assert.rejects(a.request(input,'x',()=>assert.fail()),e=>e.code==='MODEL_OUTPUT_INCOMPLETE'&&!e.message.includes('world-secret'));
  const row=a.stages[0];assert.equal(calls,1);assert.equal(row.output.requestState,'failed');assert.equal(row.output.response.text,'partial');assert.equal(row.output.response.receivedBytes,7);
  assert.equal(row.output.response.interrupted,true);assert.doesNotMatch(JSON.stringify(a.failure(Error('failed'))),/world-secret/);
});
test('legacy world responses do not invent completion or usage and diagnostics never shorten the text passed to parser',async()=>{
  const raw='world expression '.repeat(10*1024),a=fixture(async()=>raw);let parsed;
  await a.request(input,'x',value=>{parsed=value;return true;});assert.equal(parsed,raw);
  const response=a.stages[0].output.response;assert.equal(response.text.length,96*1024);assert.equal(response.truncated,true);assert.equal(response.complete,null);assert.equal(response.usage,undefined);
  assert.match(response.compatibility,/未提供/);
});
test('world diagnostic history is bounded and exported stage snapshots cannot mutate the attempt',async()=>{
  const a=fixture(async()=> 'ok');for(let i=0;i<7;i++)await a.request(input,'x',()=>true,{repairAttempt:i});
  assert.equal(a.stages.length,4);assert.deepEqual(a.stages.map(s=>s.input.repairAttempt),[3,4,5,6]);
  const rows=a.stages;rows[0].status='forged';assert.equal(a.stages[0].status,'success');
});
test('world failure is stored once with the archive log object, and storage or archive failures cannot rerun a request',async()=>{
  let stores=0,archives=0;const a=fixture(async()=>{});const options={store:(log,pipeline)=>{stores++;assert.equal(log.pipelineId,pipeline.id);},archive:log=>{archives++;assert.ok(log.pipelineId);return Promise.reject(Error('local cache full'));}};
  assert.equal(await a.fail(Error('failure'),options),true);assert.equal(await a.fail(Error('failure'),options),false);await Promise.resolve();assert.equal(stores,1);assert.equal(archives,1);
  const b=fixture(async()=>{});assert.equal(await b.fail(Error('failure'),{store:()=>{throw Error('save failed');},archive:()=>assert.fail()}),false);
});
test('stale world requests do not send, and late or changed-account failures never store diagnostics into a new context',async()=>{
  let valid=false,calls=0;const a=fixture(async()=>{calls++;return 'ok';},{guard:()=>{if(!valid)throw Object.assign(Error('changed'),{code:'storyboard_input_changed'});}});
  await assert.rejects(a.request(input,'x',()=>true),{code:'storyboard_input_changed'});assert.equal(calls,0);
  assert.equal(await a.fail(Error('late'),{store:()=>assert.fail(),archive:()=>assert.fail()}),false);
  valid=true;const b=fixture(async()=>{valid=false;return 'late';},{guard:()=>{if(!valid)throw Object.assign(Error('changed'),{code:'storyboard_input_changed'});}});
  await assert.rejects(b.request(input,'x',()=>assert.fail()),{code:'storyboard_input_changed'});assert.equal(await b.fail(Error('late'),{store:()=>assert.fail(),archive:()=>assert.fail()}),false);
});
test('world diagnostic normalization retains its label but rejects forged generation payload and image records',()=>{
  const {log,pipeline}=fixture(async()=>{}).failure(Error('bad response'));
  const state=core.normalizeStoryboardState({logs:[{...log,snapshot:{source:'novel',payload:{prompt:'forged'}},recordIds:['fake'],params:{width:1024}}],pipelineLogs:[pipeline]});
  assert.equal(state.logs[0].promptOrigin,'world');assert.equal(state.logs[0].snapshot,null);assert.deepEqual(state.logs[0].recordIds,[]);assert.deepEqual(state.logs[0].params,{});assert.equal(state.taskStates.length,0);
  assert.equal(core.normalizeStoryboardState({logs:[{...log,promptOrigin:'untrusted'}]}).logs[0].promptOrigin,undefined);
});
test('world failure renders in existing compact log with usage and exchanges, not an image retry or load action',()=>{
  const e=logFixture(),{log,pipeline}=fixture(async()=>{}).failure(Error('HTTP 401'));
  pipeline.stages.unshift({id:'usage',status:'failed',type:'world_prompt_rendering',output:{response:{usage:{total_tokens:27}}}});e.state.logs=[log];e.state.pipelineLogs=[pipeline];
  const html=e.context.renderStoryboardLogs(e.state);assert.match(html,/造物之眼/);assert.match(html,/已记录 27 token/);assert.match(html,/鉴权失败/);
  assert.doesNotMatch(html,/sd-btn sd-storyboard-(retry|load)-log/);assert.match(html,/data-log-exchange="input"/);assert.match(html,/data-log-exchange="output"/);
});
