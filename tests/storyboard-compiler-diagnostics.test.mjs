import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createStoryboardCompilerAttempt,createStoryboardCompilerInterruptionRecorder} from '../qianmu-storyboard-compiler-diagnostics.js';
import {callStoryboardCompiler} from '../qianmu-storyboard-compiler-transport.js';
import * as core from '../qianmu-storyboard.js';
import {compilerEnvironment} from './helpers/comfy-compiler-fixture.mjs';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
import {logFixture} from './helpers/storyboard-log-fixture.mjs';
const copy=value=>JSON.parse(JSON.stringify(value));
function attempt(call,extra={}){let id=0,time=100;return createStoryboardCompilerAttempt({call,guard:()=>{},uid:prefix=>`${prefix}-${++id}`,
  sanitize:core.sanitizeStoryboardDiagnosticData,startedAt:90,floor:2,model:'selected-model',now:()=>++time,...extra});}

test('per-request diagnostics keep actual completion/usage, raw output, repair role and redaction without configuration secrets',async()=>{
  const a=attempt(async(messages,id,options)=>{
    options.onResponse({text:'partial',finishReason:'length',complete:false,interrupted:true,receivedBytes:24,
      usage:{total_tokens:12,prompt_tokens:8,completion_tokens:4,apiKey:'secret-key'},reasoning:'not retained'});
    throw Object.assign(Error('HTTP 429 Authorization: Bearer private-token'),{code:'MODEL_OUTPUT_INCOMPLETE'});
  });
  await assert.rejects(a.call([{role:'user',content:'request'}],'chosen',{jsonSchemaName:'qianmu.storyboard.expression.v1',repair:true}));
  const {log,pipeline}=a.failure({message:'generic contract error',diagnostic:{stage:'expression',repairCalls:1}});
  assert.equal(log.kind,'prompt_compiler');assert.equal(log.snapshot,null);assert.match(log.error,/提示表达.*429/);
  const row=pipeline.stages[0];assert.equal(row.type,'compiler_expression_repair');assert.equal(row.status,'failed');
  assert.deepEqual(row.output.response.usage,{total_tokens:12,prompt_tokens:8,completion_tokens:4});
  assert.equal(row.output.response.text,'partial');assert.equal(row.output.response.complete,false);assert.equal(row.output.response.finishReason,'length');
  assert.doesNotMatch(JSON.stringify(pipeline),/private-token|secret-key|not retained/);
});

test('legacy final-string response is not invented as a provider completion marker or token count',async()=>{
  const a=attempt(async()=> 'full response');await a.call([{content:'source'}],null,{jsonSchemaName:'qianmu.storyboard.narrative.v1'});
  const row=a.failure(Error('invalid contract')).pipeline.stages[0];assert.equal(row.output.response.complete,null);assert.equal(row.output.response.usage,undefined);
  assert.match(row.output.response.compatibility,/未提供/);assert.equal(row.status,'success');
});

test('chosen API adapter forwards request-local callbacks to both external and existing ST transport without extra calls',async()=>{
  let calls=0;const guard=()=>true,onResponse=()=>{};
  const common={settings:{apiProfiles:[{id:'chosen',model:'m',apiKey:'secret',apiUrl:'https://chosen.invalid'}]},normalizeStoryboardPromptFormats:v=>v,
    callExternalApi:async(_m,_d,cfg)=>{calls++;assert.equal(cfg.onResponse,onResponse);assert.equal(cfg.guard,guard);assert.equal(cfg.apiKey,'secret');return 'external';},
    callSillyTavernModel:async(_m,_s,_d,cfg)=>{calls++;assert.equal(cfg.onResponse,onResponse);assert.equal(cfg.guard,guard);return 'host';}};
  assert.equal(await callStoryboardCompiler([], 'chosen',{guard,onResponse},common),'external');
  assert.equal(await callStoryboardCompiler([], '',{guard,onResponse},common),'host');assert.equal(calls,2);
});

test('actual extraction failure preserves old valid draft and provenance, creates one separate non-image log and survives normalization',async()=>{
  const e=await compilerEnvironment();assert.equal(await e.context.storyboardCompilePrompt(null),true);
  const draft=copy(e.state.promptDraft),provenance=e.state.pendingCompilerStages,prompt=e.state.prompt;let calls=0;
  e.context.storyboardCallCompiler=async()=>{calls++;return '{ invalid';};
  assert.equal(await e.context.storyboardCompilePrompt(null,{quiet:true}),false);assert.equal(calls,4);
  assert.deepEqual(copy(e.state.promptDraft),draft);assert.equal(e.state.prompt,prompt);assert.equal(e.state.pendingCompilerStages,provenance);
  assert.equal(e.state.logs.length,1);assert.equal(e.state.logs[0].kind,'prompt_compiler');assert.equal(e.state.logs[0].snapshot,null);assert.equal(e.jobs.length,0);
  const stages=e.state.pipelineLogs[0].stages;assert.equal(stages.length,5);assert.deepEqual(stages.slice(0,4).map(r=>r.type),['compiler_narrative',...Array(3).fill('compiler_narrative_repair')]);
  assert.equal(stages.at(-1).output.diagnostic.repairCalls,3);assert.match(e.state.logs[0].error,/叙事取景/);
  const restored=core.normalizeStoryboardState(copy(e.state));assert.equal(restored.logs[0].kind,'prompt_compiler');assert.equal(restored.logs[0].source,'compiler');assert.equal(restored.logs[0].snapshot,null);
  assert.equal(restored.taskStates.length,0);assert.equal(restored.pipelineLogs[0].stages.length,5);
});

test('actual expression transport failure retains narrative success and actual partial response, never retries or rewrites an old draft',async()=>{
  const e=await compilerEnvironment(),call=e.context.storyboardCallCompiler;let calls=0;
  e.context.storyboardCallCompiler=async(messages,id,options)=>{
    calls++;if(options.jsonSchemaName.includes('narrative'))return call(messages,id,options);
    options.onResponse({text:'{partial',finishReason:'length',complete:false,usage:{total_tokens:21}});
    throw Object.assign(Error('模型达到输出长度上限'),{code:'MODEL_OUTPUT_INCOMPLETE'});
  };
  assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(calls,2);
  const stages=e.state.pipelineLogs[0].stages;assert.equal(stages[0].status,'success');assert.equal(stages[1].status,'failed');
  assert.equal(stages[1].output.response.text,'{partial');assert.equal(stages[1].output.response.usage.total_tokens,21);
  assert.match(e.state.logs[0].error,/提示表达.*输出长度/);assert.equal(e.jobs.length,0);
});

test('actual same-account stale failure records only a safe interruption and never replaces the edited draft',async()=>{
  const e=await compilerEnvironment();e.context.storyboardCallCompiler=async()=>{e.state.prompt='new manual edit';throw Error('late remote failure');};
  assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.state.prompt,'new manual edit');assert.equal(e.state.logs.length,1);assert.equal(e.state.pipelineLogs.length,1);
  assert.equal(e.state.logs[0].status,'cancelled');assert.equal(e.state.logs[0].snapshot,null);
  assert.equal(e.state.pipelineLogs[0].stages.length,1);assert.deepEqual(copy(e.state.pipelineLogs[0].stages[0].input),{});
  assert.doesNotMatch(JSON.stringify(e.state.logs)+JSON.stringify(e.state.pipelineLogs),/new manual edit|late remote failure|Alice|silver hair|messages|repairMessages/);
  assert.equal(e.state.pendingCompilerStages,undefined);assert.equal(e.jobs.length,0);
});

test('a preparation failure before any model request becomes one metadata-only record in the existing log store',async()=>{
  const e=await compilerEnvironment();e.context.storyboardCompilerContext=async()=>{throw Object.assign(Error('private selected book contents'),{code:'storyboard_context_unavailable'});};
  assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);
  assert.equal(e.state.logs.length,1);assert.match(e.state.logs[0].error,/上下文读取.*参考内容/);
  assert.doesNotMatch(JSON.stringify(e.state.logs)+JSON.stringify(e.state.pipelineLogs),/private selected|apiKey|Alice/);
  const restored=core.normalizeStoryboardState(copy(e.state));assert.equal(restored.logs[0].kind,'prompt_compiler');assert.equal(restored.pipelineLogs[0].stages[0].output.reason,'context_unavailable');
});

for(const [name,change,reason,word] of [
  ['profile',e=>{e.state.profiles.novel.artDirection='cg';},'preparation_profile_changed','生图配置'],
  ['compiler',e=>{e.state.promptCompiler.includeRecentFloors=9;},'preparation_compiler_changed','取景设置'],
  ['world selection',e=>{e.state.promptCompiler.worldBookNames=['private new selection'];},'preparation_world_selection_changed','世界书'],
  ['source',e=>{e.state.source='comfy';},'preparation_config_changed','准备设置'],
])test(`the real guard snapshots ${name} before diagnostic identity awaits and records its actual reason enum`,async()=>{
  const e=await compilerEnvironment();let release,reached;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{reached=resolve;});
  e.context.resolveImageAccountNamespace=async()=>{reached();await gate;return 'st-user:route-test';};
  const work=e.context.storyboardCompilePrompt(null);await started;change(e);release();
  assert.equal(await work,false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);
  assert.equal(e.state.logs.length,1);assert.equal(e.state.pipelineLogs[0].stages[0].output.reason,reason);assert.match(e.state.logs[0].error,new RegExp(word));
  assert.doesNotMatch(JSON.stringify(e.state.logs)+JSON.stringify(e.state.pipelineLogs),/private new selection/);
});

test('a Comfy preflight failure records its stage without submitting, retrying or storing the error payload',async()=>{
  const e=await compilerEnvironment();e.state.source='comfy';e.context.storyboardPreflightComfyForCompiler=async()=>{throw Object.assign(Error('private workflow and Bearer secret'),{comfyPreflight:true});};
  assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.llmCalls.length,0);assert.equal(e.jobs.length,0);
  assert.equal(e.state.logs.length,1);assert.match(e.state.logs[0].error,/工作流检查.*输出节点/);
  assert.doesNotMatch(JSON.stringify(e.state.logs)+JSON.stringify(e.state.pipelineLogs),/private workflow|secret/);
});

for(const boundary of ['chat','state','epoch','account'])test(`an extraction interruption after changing ${boundary} never appends a diagnostic to the new owner`,async()=>{
  const e=await compilerEnvironment();e.context.storyboardCallCompiler=async()=>{
    if(boundary==='chat')e.context.getChatKey=()=> 'different-chat';
    if(boundary==='state')e.context.storyboardState=()=>core.createStoryboardDefaults();
    if(boundary==='epoch')e.context.storyboardAdmissionEpoch++;
    if(boundary==='account')e.setAccount('st-user:different-account');
    throw Object.assign(Error('private late response'),{code:'storyboard_input_changed'});
  };
  assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.equal(e.state.logs.length,0);assert.equal(e.state.pipelineLogs.length,0);assert.equal(e.jobs.length,0);
});

test('an unavailable diagnostic identity proof cannot stop an otherwise valid extraction',async()=>{
  const e=await compilerEnvironment();e.context.resolveImageAccountNamespace=async()=>{throw Error('identity unavailable for diagnostic');};
  assert.equal(await e.context.storyboardCompilePrompt(null),true);assert.equal(e.state.logs.length,0);assert.equal(e.llmCalls.length,2);
});

test('metadata recorder permits a single verified write, rejects unknown payloads, and never serializes private values',async()=>{
  let id=0,reads=0;const stored=[];
  const record=await createStoryboardCompilerInterruptionRecorder({ownsContext:()=>true,resolveNamespace:async()=>{reads++;return 'st-user:a';},store:(log,pipeline)=>stored.push({log,pipeline}),uid:p=>`${p}-${++id}`,startedAt:1,floor:3,now:()=>10});
  const error=Object.assign(Error('private prompt'),{diagnostic:{apiKey:'key',messages:['secret']},code:'unknown-secret'});
  const writes=await Promise.all([record({stage:'private-stage',reason:'private-reason',error}),record({stage:'workflow',error})]);
  assert.deepEqual(writes,[true,true]);assert.equal(stored.length,1);assert.equal(reads,2);
  assert.equal(stored[0].pipeline.stages[0].output.reason,'preparation_failed');assert.doesNotMatch(JSON.stringify(stored),/private|secret|apiKey|messages/);
});

test('metadata identity checks fail closed both while establishing ownership and immediately before committing',async()=>{
  for(const phase of ['initial','final']){
    let owned=true,reads=0,writes=0,release;
    const gate=new Promise(resolve=>{release=resolve;});
    const started=createStoryboardCompilerInterruptionRecorder({ownsContext:()=>owned,resolveNamespace:async()=>{reads++;if(reads===(phase==='initial'?1:2))await gate;return 'st-user:a';},store:()=>writes++,uid:()=> 'id',startedAt:1,floor:0});
    const pending=phase==='initial'?started:Promise.resolve((await started)({cancelled:true}));
    owned=false;release();const result=await pending;if(typeof result==='function')assert.equal(await result({cancelled:true}),false);else assert.equal(result,false);
    assert.equal(writes,0);
  }
});

test('actual compiler failure passes the expected log object to the archive instead of an unresolvable id string',async()=>{
  const e=await compilerEnvironment(),archived=[];e.context.storyboardCallCompiler=async()=>{throw Error('HTTP 401');};
  e.context.storyboardArchivePipelineLog=async log=>{archived.push(log);};assert.equal(await e.context.storyboardCompilePrompt(null),false);
  assert.equal(archived.length,1);assert.equal(archived[0].pipelineId,e.state.logs[0].pipelineId);
});

test('automatic quiet extraction still explains an initial request failure without scheduling a retry',async()=>{
  const e=await compilerEnvironment();let calls=0;
  e.context.storyboardCallCompiler=async()=>{calls++;throw Error('HTTP 401 unauthorized');};
  assert.equal(await e.context.storyboardCompilePrompt(null,{quiet:true,automatic:true}),false);
  assert.equal(calls,1);assert.match(e.notices.at(-1),/401/);assert.equal(e.state.logs[0].kind,'prompt_compiler');assert.equal(e.jobs.length,0);
});

test('actual log storage failure rolls back logs and does not mask the primary extraction failure',async()=>{
  const e=await compilerEnvironment();e.context.storyboardCallCompiler=async()=>{throw Error('HTTP 429 rate limit');};
  const draft=copy(e.state.promptDraft);e.context.saveSettings=()=>{throw Error('storage unavailable');};
  assert.equal(await e.context.storyboardCompilePrompt(null),false);assert.deepEqual(copy(e.state.promptDraft),draft);assert.equal(e.state.logs.length,0);assert.equal(e.state.pipelineLogs.length,0);
  assert.match(e.notices.at(-1),/429/);
});

test('compiler diagnostics render only copy controls, without image geometry or retry/load actions; forged snapshots cannot bypass handlers',async()=>{
  const {state,context}=logFixture(),{log,pipeline}=attempt(async()=>{}).failure(Error('format error'));
  state.logs=[log];state.pipelineLogs=[pipeline];const html=context.renderStoryboardLogs(state);
  assert.match(html,/取景 API/);assert.match(html,/sd-storyboard-copy-log/);assert.doesNotMatch(html,/class="sd-btn sd-storyboard-(?:retry|load)-log"|沿用尺寸/);
  const e=await compilerEnvironment();vm.runInContext(['storyboardJobFromLog','storyboardRetryLog','storyboardLoadLogToWorkbench'].map(section).join('\n'),e.context);
  const forged={...log,snapshot:{source:'novel',payload:{prompt:'must not run'},profile:{model:'x'},connection:{baseUrl:'https://x',credentialId:'secret'}}};
  assert.equal(e.context.storyboardJobFromLog(forged),null);assert.equal(await e.context.storyboardRetryLog(forged),false);assert.equal(e.context.storyboardLoadLogToWorkbench(forged),false);
  assert.equal(core.normalizeStoryboardState({logs:[forged]}).logs[0].snapshot,null);assert.equal(e.jobs.length,0);
});
