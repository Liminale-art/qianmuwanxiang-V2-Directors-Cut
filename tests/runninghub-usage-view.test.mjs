import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {normalizeStoryboardState} from '../qianmu-storyboard.js';
import {readRunningHubTaskUsage, runningHubUsageFields, renderRunningHubTaskUsage} from '../qianmu-runninghub-usage.js';
import {storyboardFunctionSource as section} from './helpers/storyboard-form-fixture.mjs';

const response=()=>({provider:'runninghub',upstreamId:'999999999999999999',images:[{},{}],delivery:{usage:{consumeCoins:'1.230000',consumeMoney:'0'}}});

test('persisted log summary is scoped to an original task, preserves decimal precision and strips unrelated data',()=>{
  const fields=runningHubUsageFields(response()),raw={...fields.cloudUsage,apiKey:'must-not-persist'};
  const state=normalizeStoryboardState({logs:[{id:'one',source:'comfy',status:'success',cloudUsage:raw},{id:'old',source:'comfy'}]});
  const saved=state.logs.find(l=>l.id==='one');
  assert.deepEqual(saved.cloudUsage,fields.cloudUsage);assert.equal(Object.hasOwn(state.logs.find(l=>l.id==='old'),'cloudUsage'),false);
  const html=renderRunningHubTaskUsage(saved);assert.match(html,/整次任务用量（非单张）/);assert.match(html,/RH币 1\.230000.*平台金额 0/);
  assert.doesNotMatch(html,/must-not-persist|￥|USD|每张/);
  assert.equal(renderRunningHubTaskUsage({cloudUsage:{...raw,taskId:'<img src=x>'}}),'');
  assert.equal(readRunningHubTaskUsage({get provider(){assert.fail('accessor must not run');}}),null);
  assert.deepEqual(runningHubUsageFields({...response(),provider:'comfy-cloud'}),{});
  assert.deepEqual(runningHubUsageFields({...response(),delivery:{}}),{});
});

test('real delivery checkpoints and deferred/current galleries keep the same task report on each variant without multiplying it',async()=>{
  for(const foreign of [false,true])for(const originalOnly of [false,true]) {
    const gallery=[],checkpoints=[],finished=[];let deferred=[];
    const context=vm.createContext({runningHubUsageFields,clone:structuredClone,
      storyboardPlanForJob:()=>null,storyboardSetPlanStatus:()=>{},storyboardPipelineStage:()=>{},
      storyboardPersistGatewayImage:async(_image,_job,index)=>`/local-${index}.png`,
      storyboardValidatedAnchor:()=>({valid:true,floor:2}),
      storyboardCreateRecord:(_job,_log,url,index)=>({id:'unused',imageIndex:index,url}),
      sanitizeStoryboardSnapshot:()=>({}),getChatKey:()=>foreign?'other':'chat',ctx:()=>({saveMetadata(){}}),
      storyboardGalleryRecords:()=>gallery,saveMetadata:async()=>{},storyboardArchiveGallerySnapshots:()=>{},storyboardDeleteRecordSnapshots:()=>{},
      storyboardStoreDeferredDelivery:async(_job,records)=>{deferred=structuredClone(records);return 'pending_chat';},
      storyboardFinishLog:(_log,_status,details)=>finished.push(details),toast:()=>{},
    });
    vm.runInContext(section('storyboardDeliverGatewayResult'),context);
    const job={id:'job',chatKey:'chat',source:'comfy',originalOnly,profile:{},automatic:true};
    const options={service:true,checkpoint:async records=>checkpoints.push(structuredClone(records))};
    await context.storyboardDeliverGatewayResult(job,{},response(),options);
    const records=foreign?deferred:gallery;
    assert.equal(records.length,2);assert.equal(checkpoints.length,2);
    for(const row of [...records,...checkpoints.at(-1),finished.at(-1)])assert.deepEqual(row.cloudUsage,runningHubUsageFields(response()).cloudUsage);
    await context.storyboardDeliverGatewayResult(job,{},response(),{...options,archiveRecords:records});
    assert.equal((foreign?deferred:gallery).length,2,'retry cannot duplicate images or double the reported task price');
  }
});

test('actual log finish and collapsed renderer preserve summary without opening the large exchange payload',()=>{
  const log={id:'log',source:'comfy',startedAt:1},state={logs:[log]};
  const c=vm.createContext({renderRunningHubTaskUsage,storyboardPipelineForLog:()=>null,saveSettings:()=>{},storyboardArchivePipelineLog:()=>{},
    STORYBOARD_SOURCES:{comfy:{label:'Comfy'}},storyboardLogPresentation:()=>({tone:'green',kind:'生图',tokens:'token 未提供'}),
    htmlEscape:String,formatDateTime:()=>'',storyboardCanReceiveComfyLog:()=>false,storyboardActiveJobs:new Map(),storyboardQueue:[]});
  vm.runInContext(section('storyboardFinishLog')+'\n'+section('renderStoryboardLogs'),c);
  c.storyboardFinishLog(log,'success',runningHubUsageFields(response()));
  const html=c.renderStoryboardLogs(state);assert.match(html,/整次任务用量（非单张）/);assert.match(html,/999999999999999999/);
  assert.doesNotMatch(html,/<details[^>]*\sopen/);
});
