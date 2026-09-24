import vm from 'node:vm';
import * as core from '../../qianmu-storyboard.js';
import {renderRunningHubTaskUsage} from '../../qianmu-runninghub-usage.js';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';
const names=['storyboardLogPresentation','storyboardLogExchangeText','bindStoryboardLogExchange','renderStoryboardLogs'];
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function logFixture(){
  const state={logs:[],pipelineLogs:[],logFilter:'failed'},context=vm.createContext({...core,renderRunningHubTaskUsage,htmlEscape:escape,formatDateTime:()=> '2026/9/7 23:10:00',
    STORYBOARD_PIPELINE_STAGE_LABELS:{provider_request:'模型请求',prompt_compiler:'镜头规划'},storyboardActiveJobs:new Map(),storyboardQueue:[],
    storyboardQueuePendingCount:()=>0,storyboardQueueSettling:0,
    storyboardState:()=>state,storyboardCanReceiveComfyLog:log=>Boolean(log.comfyReceipt),storyboardPipelineForLog:log=>state.pipelineLogs.find(p=>p.id===log.pipelineId)});
  vm.runInContext(names.map(section).join('\n'),context);return {state,context};
}
