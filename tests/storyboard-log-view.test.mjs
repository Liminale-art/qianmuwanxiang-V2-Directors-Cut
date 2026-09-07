import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as core from '../qianmu-storyboard.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';
const names=['storyboardLogPresentation','storyboardLogExchangeText','bindStoryboardLogExchange','renderStoryboardLogs'];
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function logFixture(){
  const state={logs:[],pipelineLogs:[],logFilter:'failed'},context=vm.createContext({...core,htmlEscape:escape,formatDateTime:()=> '2026/9/7 23:10:00',
    STORYBOARD_PIPELINE_STAGE_LABELS:{provider_request:'模型请求',prompt_compiler:'镜头规划'},storyboardActiveJobs:new Map(),storyboardQueue:[],
    storyboardState:()=>state,storyboardCanReceiveComfyLog:log=>Boolean(log.comfyReceipt),storyboardPipelineForLog:log=>state.pipelineLogs.find(p=>p.id===log.pipelineId)});
  vm.runInContext(names.map(section).join('\n'),context);return {state,context};
}
test('all records render despite persisted old filter, initially folded with four statuses and no empty cards',()=>{
  const {state,context:c}=logFixture();assert.doesNotMatch(c.renderStoryboardLogs(state),/sd-card sd-storyboard-log|sd-storyboard-empty|sd-storyboard-log-head|log-filters/);
  state.logs=['success','failed','queued','generating','cancelled'].map((status,i)=>({id:'log'+i,status,source:'novel',model:'<unsafe model>',params:{}}));
  const html=c.renderStoryboardLogs(state);assert.equal((html.match(/data-storyboard-log=/g)||[]).length,5);assert.doesNotMatch(html,/<details[^>]*\sopen|<unsafe model>|data-storyboard-log-filter/);
  for(const tone of ['grey','yellow','red','green'])assert.match(html,new RegExp(`data-tone="${tone}"`));
});
test('collapsed rendering never serializes large inputs or outputs and preserves receive/retry/diagnostic tools',()=>{
  const {state,context:c}=logFixture();state.logs=[{id:'one',status:'failed',source:'comfy',pipelineId:'p',comfyReceipt:true}];
  state.pipelineLogs=[{id:'p',stages:[{id:'s',type:'provider_request',status:'failed',input:{get request(){throw Error('must not read a closed payload');}},output:{response:{}}}]}];
  const html=c.renderStoryboardLogs(state);for(const token of ['data-log-exchange="input"','data-log-exchange="output"','sd-storyboard-receive-comfy','sd-storyboard-retry-log','sd-storyboard-copy-log','sd-storyboard-pack-export'])assert.ok(html.includes(token));
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
test('exchange wrapping does not add another depth cutoff to already-retained stage payloads',()=>{
  const {context:c}=logFixture();let input={value:'deep original'};for(let n=0;n<15;n++)input={nested:input};
  const retained=core.sanitizeStoryboardDiagnosticData(input),result=JSON.parse(c.storyboardLogExchangeText({}, {stages:[{type:'provider_request',input:retained}]},'input'));
  assert.deepEqual(result[0].input,retained);
});
test('actual row binding inserts plain text only while open, clears on close and refuses detached or replaced state',()=>{
  const {state,context:c}=logFixture(),log={id:'one',prompt:'<script>not html</script>',status:'success'};state.logs=[log];
  const bodies=['input','output'].map(side=>({textContent:'',parentElement:{dataset:{logExchange:side}}}));let toggle;
  const row={open:false,isConnected:true,querySelectorAll:()=>bodies,addEventListener:(name,cb)=>toggle=cb};c.bindStoryboardLogExchange(row,log,state);
  assert.ok(bodies.every(b=>b.textContent===''));row.open=true;toggle({target:row});assert.match(bodies[0].textContent,/<script>not html<\/script>/);
  row.open=false;toggle({target:row});assert.ok(bodies.every(b=>b.textContent===''));row.open=true;row.isConnected=false;toggle({target:row});assert.ok(bodies.every(b=>b.textContent===''));
  row.isConnected=true;state.logs=[];toggle({target:row});assert.ok(bodies.every(b=>b.textContent===''));
});
