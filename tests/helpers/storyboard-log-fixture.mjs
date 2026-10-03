import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as core from '../../qianmu-storyboard.js';
import {renderRunningHubTaskUsage} from '../../qianmu-runninghub-usage.js';
import {storyboardFunctionSource as section} from './storyboard-form-fixture.mjs';
const names=['storyboardLogPresentation','storyboardLogExchangeText','storyboardStageText','bindStoryboardLogExchange','bindStoryboardLogStages','renderStoryboardLogs'];
const entry=readFileSync(new URL('../../index.js',import.meta.url),'utf8');
const labels=entry.slice(entry.indexOf('const STORYBOARD_PIPELINE_STAGE_LABELS ='),entry.indexOf('\nfunction storyboardStageText('));
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function logFixture(){
  const state={logs:[],pipelineLogs:[],logFilter:'failed'},context=vm.createContext({...core,renderRunningHubTaskUsage,htmlEscape:escape,formatDateTime:()=> '2026/9/7 23:10:00',
    storyboardActiveJobs:new Map(),storyboardQueue:[],
    storyboardQueuePendingCount:()=>0,storyboardQueueSettling:0,
    storyboardState:()=>state,storyboardCanReceiveComfyLog:log=>Boolean(log.comfyReceipt),storyboardPipelineForLog:log=>state.pipelineLogs.find(p=>p.id===log.pipelineId)});
  vm.runInContext(labels+'\n'+names.map(section).join('\n'),context);return {state,context};
}
