import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../qianmu-storyboard.js';
import {logFixture} from './helpers/storyboard-log-fixture.mjs';
test('all records render despite persisted old filter, initially folded with four statuses and no empty log cards',()=>{
  const {state,context:c}=logFixture();assert.doesNotMatch(c.renderStoryboardLogs(state),/sd-card sd-storyboard-log|sd-storyboard-empty|sd-storyboard-log-head|log-filters/);
  state.logs=['success','failed','queued','generating','cancelled'].map((status,i)=>({id:'log'+i,status,source:'novel',model:'<unsafe model>',params:{}}));
  const html=c.renderStoryboardLogs(state);assert.equal((html.match(/data-storyboard-log=/g)||[]).length,5);assert.doesNotMatch(html,/<details[^>]*\sopen|<unsafe model>|data-storyboard-log-filter/);
  for(const tone of ['grey','yellow','red','green'])assert.match(html,new RegExp(`data-tone="${tone}"`));
});
test('empty logs have no receipt managers or resource bundle controls',()=>{
  const {state,context:c}=logFixture(),before=structuredClone(state),html=c.renderStoryboardLogs(state);
  assert.match(html,/<section class="sd-storyboard-log-maintenance" aria-label="日志工具">/);
  assert.doesNotMatch(html,/<details|日志管理|sd-storyboard-export-logs|sd-storyboard-clear-logs/);
  for(const token of ['sd-storyboard-open-service-inbox','sd-storyboard-open-comfy-inbox','sd-storyboard-service-inbox','sd-storyboard-comfy-inbox','sd-storyboard-pack-export','sd-storyboard-pack-recover','sd-storyboard-pack-file'])assert.ok(!html.includes(token),token);
  assert.match(html,/class="sd-storyboard-logs-empty" role="status">暂无取景或生图记录。<\/p>/);
  assert.deepEqual(state,before,'rendering does not fetch, migrate or rewrite history');
});
test('non-empty logs expose only an accessible clear icon with in-flight protection',()=>{
  const {state,context:c}=logFixture();state.logs=[{id:'one',status:'failed',source:'comfy',params:{}}];
  const render=()=>c.renderStoryboardLogs(state),tools=()=>render().split('</section>')[0];
  assert.doesNotMatch(render(),/sd-storyboard-logs-empty/);
  assert.doesNotMatch(tools(),/sd-storyboard-export-logs|导出日志|>清空日志</);
  assert.match(tools(),/class="sd-icon-btn sd-storyboard-clear-logs" title="清空日志" aria-label="清空日志" ><i class="fa-solid fa-trash-can" aria-hidden="true"><\/i><\/button>/);
  const disabled=()=>assert.match(tools(),/sd-storyboard-clear-logs"[^>]* disabled/);
  c.storyboardActiveJobs.set('active',{});disabled();c.storyboardActiveJobs.clear();
  c.storyboardQueue.push({});disabled();c.storyboardQueue.length=0;
  c.storyboardQueuePendingCount=()=>1;disabled();c.storyboardQueuePendingCount=()=>0;
  c.storyboardQueueSettling=1;disabled();
  c.storyboardQueueSettling=0;c.storyboardReceiveComfyImage.pending=1;disabled();
  c.storyboardReceiveComfyImage.pending=0;c.storyboardReceiveServiceImage.pending=1;disabled();
});
test('task result is simple but unknown accepted work is never mislabeled failed',()=>{
  const {state,context:c}=logFixture();
  state.logs=[{id:'unsent',status:'failed',submissionState:'not_submitted',source:'novel',params:{}},
    {id:'uncertain',status:'failed',submissionState:'unknown',source:'novel',params:{}},
    {id:'accepted',status:'failed',submissionState:'accepted',source:'novel',params:{}},
    {id:'rejected',status:'failed',submissionState:'rejected',source:'novel',params:{}}];
  const html=c.renderStoryboardLogs(state);
  const row=id=>html.split(`data-storyboard-log="${id}"`)[1]?.split('<details class="sd-card sd-storyboard-log')[0]||'';
  assert.match(row('unsent'),/sd-storyboard-log-status">失败</);
  assert.match(row('uncertain'),/sd-storyboard-log-status">未完成</);
  assert.match(row('accepted'),/sd-storyboard-log-status">未完成</);
  assert.doesNotMatch(html,/核查并重试|领取原图|再生成|sd-storyboard-retry-log/);
  assert.match(row('rejected'),/sd-storyboard-log-status">失败</);
  state.logs[2].params.upstreamStatus='failed';assert.match(c.renderStoryboardLogs(state),/#accepted<\/span><\/span><time>[^<]*<\/time><span class="sd-storyboard-log-status">失败/);
});
test('collapsed rendering never serializes large inputs or outputs and keeps only diagnostic tools',()=>{
  const {state,context:c}=logFixture();state.logs=[{id:'one',status:'failed',source:'comfy',pipelineId:'p',comfyReceipt:true}];
  state.pipelineLogs=[{id:'p',stages:[{id:'s',type:'provider_request',status:'failed',input:{get request(){throw Error('must not read a closed payload');}},output:{response:{}}}]}];
  const html=c.renderStoryboardLogs(state);for(const token of ['data-log-exchange="input"','data-log-exchange="output"','sd-storyboard-copy-log'])assert.ok(html.includes(token));
  assert.doesNotMatch(html,/sd-storyboard-receive-comfy|sd-storyboard-retry-log|sd-storyboard-pack-export|sd-storyboard-load-log/);
  assert.match(html,/data-log-exchange="input"><header>↑ 发送<\/header><pre><\/pre>/);
});
test('full exchange keeps long original/repaired output, relocates repair messages, and redacts credentials without mutating data',()=>{
  const {context:c}=logFixture(),long='中文 raw '.repeat(20000)+'END',pipeline={stages:[{type:'prompt_compiler',status:'success',input:{messages:[{content:long}],apiKey:'private-key'},output:{initialResponse:long,repairMessages:[{content:'repair-request'}],repairResponse:'repair-response',parsedStructure:{shots:[]}}}]};
  const before=structuredClone(pipeline),input=c.storyboardLogExchangeText({},pipeline,'input'),output=c.storyboardLogExchangeText({},pipeline,'output');
  assert.ok(input.includes(long)&&output.includes(long));assert.match(input,/repair-request/);assert.doesNotMatch(input,/private-key/);assert.doesNotMatch(output,/repair-request/);assert.match(output,/repair-response/);assert.deepEqual(pipeline,before);
});
test('token amounts are reported only when provided, preserve zero, sum known stages without guessing missing usage',()=>{
  const {context:c}=logFixture(),meta=stages=>c.storyboardLogPresentation({}, {stages}).tokens;
  assert.equal(meta([]),'token 未提供');assert.equal(meta([{output:{usage:{total_tokens:0}}}]),'已记录 0 token');
  assert.equal(meta([{output:{response:{usage:{prompt_tokens:10,completion_tokens:5}}}},{output:{response:{usageMetadata:{totalTokenCount:8}}}},{output:{}}]),'已记录 23 token');
  assert.equal(meta([{output:{usage:{total_tokens:'50'}}}]),'token 未提供');
});
test('short failure explanation never replaces full redacted errors',()=>{
  const {context:c}=logFixture(),error='HTTP 429: too many requests\n'+ 'long error'.repeat(1000);
  assert.equal(c.storyboardLogPresentation({status:'failed',error},null).reason,'请求受限，请稍后重试');assert.ok(c.storyboardLogExchangeText({error},null,'output').includes('long error'.repeat(1000)));
  assert.match(c.storyboardLogExchangeText({prompt:'legacy'},null,'input'),/仅为现有摘要/);
});
test('successful log summaries never promote retained historical errors while stage details and exchanges stay intact',()=>{
  const oldError='云任务处理未完成，请核查原记录；未重新生成';
  for(const error of ['',oldError]){
    const {state,context:c}=logFixture(),log={id:'recovered',status:'success',source:'comfy',submissionState:'accepted',pipelineId:'p',error};
    const pipeline={id:'p',status:'success',stages:[{id:'request',type:'provider_request',status:'failed',error:oldError},
      {id:'saved',type:'asset_persistence',status:'success',output:{saved:true}}]};
    state.logs=[log];state.pipelineLogs=[pipeline];const before=structuredClone(state);
    assert.equal(c.storyboardLogPresentation(log,pipeline).reason,'');
    const html=c.renderStoryboardLogs(state),summary=html.split('data-storyboard-log="recovered"')[1].split('</summary>')[0];
    assert.match(summary,/sd-storyboard-log-status">成功/);assert.doesNotMatch(summary,/summary-reason|云任务处理未完成/);
    assert.ok(html.includes(`sd-storyboard-stage-error">${oldError}</small>`),'historical failure stays under its original stage');
    const output=JSON.parse(c.storyboardLogExchangeText(log,pipeline,'output'));
    assert.equal(output[0].status,'failed');assert.equal(output[0].error,oldError);assert.equal(output[1].output.saved,true);
    assert.deepEqual(state,before,'rendering never cleans or rewrites stored logs and pipeline history');
  }
});
test('unknown originals preserve diagnostics but never expose backend recovery chores in the list',()=>{
  const {state,context:c}=logFixture(),error='原请求结果和费用仍未知';
  state.logs=['unknown','accepted'].map((submissionState,index)=>({id:`pending-${index}`,status:'failed',submissionState,source:'comfy',error}));
  const before=structuredClone(state),html=c.renderStoryboardLogs(state);
  assert.doesNotMatch(html,/sd-storyboard-log-summary-reason|待核查|请勿直接重新生成/);
  assert.equal((html.match(/连接中断，尚未收到最终结果。/g)||[]).length,2);
  assert.match(c.storyboardLogExchangeText(state.logs[0],null,'output'),/原请求结果和费用仍未知/);
  assert.deepEqual(state,before);
});
test('exchange wrapping does not add another depth cutoff to already-retained stage payloads',()=>{
  const {context:c}=logFixture();let input={value:'deep original'};for(let n=0;n<15;n++)input={nested:input};
  const retained=core.sanitizeStoryboardDiagnosticData(input),result=JSON.parse(c.storyboardLogExchangeText({}, {stages:[{type:'provider_request',input:retained}]},'input'));
  assert.deepEqual(result[0].input,retained);
});
test('actual exchange binding reads no full payload until explicitly expanded, clears on either close and refuses stale state',()=>{
  const {state,context:c}=logFixture(),log={id:'one',prompt:'<script>not html</script>',status:'success'};state.logs=[log];
  const bodies=['input','output'].map(side=>({textContent:'',parentElement:{dataset:{logExchange:side}}}));let toggle,foldToggle;
  const fold={open:false,addEventListener:(name,cb)=>foldToggle=cb};
  const row={open:false,isConnected:true,querySelector:()=>fold,querySelectorAll:()=>bodies,addEventListener:(name,cb)=>toggle=cb};c.bindStoryboardLogExchange(row,log,state);
  assert.ok(bodies.every(b=>b.textContent===''));row.open=true;toggle({target:row});assert.ok(bodies.every(b=>b.textContent===''));
  fold.open=true;foldToggle();assert.match(bodies[0].textContent,/<script>not html<\/script>/);
  fold.open=false;foldToggle();assert.ok(bodies.every(b=>b.textContent===''));fold.open=true;foldToggle();
  row.open=false;toggle({target:row});assert.ok(bodies.every(b=>b.textContent===''));row.open=true;row.isConnected=false;toggle({target:row});assert.ok(bodies.every(b=>b.textContent===''));
  row.isConnected=true;state.logs=[];toggle({target:row});assert.ok(bodies.every(b=>b.textContent===''));
});

test('each stage owns its inline disclosure; human labels, errors and full exchange are not appended as one detached detail',()=>{
  const {state,context:c}=logFixture();state.logs=[{id:'one',status:'failed',source:'comfy',pipelineId:'p',submissionState:'unknown'}];
  state.pipelineLogs=[{id:'p',stages:[{id:'audit',type:'comfy_workflow_audit',status:'success'},
    {id:'request',type:'provider_request',status:'failed',error:'HTTP 429: too many requests\nprivate detail'}]}];
  const html=c.renderStoryboardLogs(state),items=[...html.matchAll(/<li class="[^"]*">([\s\S]*?)<\/li>/g)].map(match=>match[1]);
  assert.equal(items.length,2);assert.doesNotMatch(html,/comfy_workflow_audit/);
  assert.match(items[0],/工作流检查/);assert.match(items[1],/sd-storyboard-stage-error">请求受限，请稍后重试/);
  for(const [index,item] of items.entries()){
    assert.match(item,new RegExp(`aria-controls="sd-log-stage-0-${index}" aria-expanded="false"`));
    assert.match(item,new RegExp(`id="sd-log-stage-0-${index}" class="sd-storyboard-stage-detail" hidden`));
    assert.match(item,/<button type="button" class="sd-storyboard-copy-stage|class="sd-icon-btn sd-storyboard-copy-stage/);
    assert.match(item,/<pre><\/pre><\/section>$/);
  }
  assert.doesNotMatch(html,/<\/ol>\s*<section class="sd-storyboard-stage-detail"/);
  assert.match(html,/<details class="sd-storyboard-log-exchanges"><summary>完整发送与返回<\/summary>/);
  assert.doesNotMatch(html,/sd-storyboard-log-summary-reason|请勿直接重新生成/);
  const summary=html.split('data-storyboard-log="one"')[1].split('</summary>')[0];
  assert.doesNotMatch(summary,/请求受限|工作流检查|<small/);assert.match(summary,/#one/);
  assert.doesNotMatch(html,/token 未提供|private detail/);
});

test('numeric disclosure IDs tolerate normalized legacy surrogate IDs and do not collide across logs or stages',()=>{
  const {state,context:c}=logFixture(),logId='legacy\ud800',stageId='stage\udfff';
  const normalized=core.normalizeStoryboardState({logs:[{id:logId,status:'failed',source:'comfy',pipelineId:'p'},
    {id:'a-b',status:'success',source:'comfy',pipelineId:'q'},{id:'a',status:'success',source:'comfy',pipelineId:'r'}],pipelineLogs:[
    {id:'p',stages:[{id:stageId,type:'provider_request',status:'failed'},{id:'other',type:'asset_persistence',status:'success'}]},
    {id:'q',stages:[{id:'c',type:'provider_request',status:'success'}]},
    {id:'r',stages:[{id:'b-c',type:'provider_request',status:'success'}]}]});
  Object.assign(state,normalized);const before=JSON.stringify(state),html=c.renderStoryboardLogs(state);
  assert.ok(html.includes(`data-storyboard-log="${logId}"`));assert.ok(html.includes(`data-storyboard-stage="${stageId}"`));
  const ids=[...html.matchAll(/id="(sd-log-stage-\d+-\d+)"/g)].map(match=>match[1]);
  assert.deepEqual(ids,['sd-log-stage-0-0','sd-log-stage-0-1','sd-log-stage-1-0','sd-log-stage-2-0']);
  for(const id of ids)assert.ok(html.includes(`aria-controls="${id}"`));
  assert.equal(new Set(ids).size,4);assert.equal(JSON.stringify(state),before);
});

function stageBindingFixture(){
  const {state,context:c}=logFixture(),log={id:'one',status:'failed',pipelineId:'p'},copied=[];state.logs=[log];
  state.pipelineLogs=[{id:'p',stages:[{id:'first',type:'provider_request',status:'failed',input:{prompt:'<not-html>',apiKey:'secret'}},
    {id:'second',type:'asset_persistence',status:'success',output:{saved:true}}]}];
  const node=()=>({events:{},attrs:{},addEventListener(name,cb){this.events[name]=cb;},setAttribute(name,value){this.attrs[name]=value;}});
  const buttons=state.pipelineLogs[0].stages.map(stage=>{
    const button=node(),copy=node(),pre={textContent:''},detail={hidden:true,querySelector:selector=>selector==='pre'?pre:copy};
    button.dataset={storyboardStage:stage.id};button.parentElement={querySelector:()=>detail};button.detail=detail;button.copy=copy;button.pre=pre;return button;
  });
  const row=Object.assign(node(),{open:true,isConnected:true,querySelectorAll:()=>buttons});
  c.coreadCopyText=async value=>copied.push(value);c.toast=()=>{};c.bindStoryboardLogStages(row,log,state);
  return {state,c,row,buttons,copied};
}
test('actual stage binding expands only its own node, serializes lazily, and clears other stages instead of duplicating long payloads',async()=>{
  const f=stageBindingFixture(),[a,b]=f.buttons;assert.equal(a.pre.textContent,'');assert.equal(b.pre.textContent,'');
  a.events.click();assert.equal(a.detail.hidden,false);assert.equal(a.attrs['aria-expanded'],'true');assert.match(a.pre.textContent,/<not-html>/);assert.doesNotMatch(a.pre.textContent,/secret/);assert.equal(b.pre.textContent,'');
  a.copy.events.click();await Promise.resolve();assert.equal(f.copied.length,1);assert.equal(f.copied[0],a.pre.textContent);
  b.events.click();assert.equal(a.detail.hidden,true);assert.equal(a.pre.textContent,'');assert.equal(a.attrs['aria-expanded'],'false');assert.match(b.pre.textContent,/saved/);
  b.events.click();assert.equal(b.detail.hidden,true);assert.equal(b.pre.textContent,'');
  a.events.click();f.row.open=false;f.row.events.toggle({target:f.row});assert.equal(a.detail.hidden,true);assert.equal(a.pre.textContent,'');
});
test('stage binding refuses disconnected, closed and replaced logs, and removed pipeline stages',()=>{
  for(const change of [f=>f.row.isConnected=false,f=>f.row.open=false,f=>f.state.logs=[],f=>f.state.pipelineLogs=[]]){
    const f=stageBindingFixture(),a=f.buttons[0];change(f);a.events.click();a.copy.events.click();
    assert.equal(a.detail.hidden,true);assert.equal(a.pre.textContent,'');assert.equal(f.copied.length,0);
  }
});
