import {createStoryboardDefaults,migrateStoryboardState,normalizeStoryboardState,normalizeStoryboardGenerationPolicy,normalizeStoryboardConnectionProfile,STORYBOARD_PROVIDER_REGISTRY,STORYBOARD_PIPELINE_LOG_LIMIT} from './qianmu-storyboard.js';
import {STORYBOARD_IMPORT_FIELDS} from './qianmu-storyboard-package-mutation.js';
import {STORYBOARD_ADDED_IMPORT_FIELDS,assertStoryboardSelectionRestoreScope,assertStoryboardAdditionalSettingsRetained} from './qianmu-storyboard-package-fields.js';
import {storyboardConnectionsShareTarget,storyboardConnectionRestoreReview} from './qianmu-storyboard-connection-identity.js';
const fail=message=>{throw new Error(message);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const limits={parameterPresets:200,promptPresets:200,artistPresets:200,artistCollections:100,artistPools:100,tagLibrary:2000,vibeLibrary:500,logs:STORYBOARD_PIPELINE_LOG_LIMIT,pipelineLogs:STORYBOARD_PIPELINE_LOG_LIMIT,shotPlans:300,taskStates:300};
const idle=['idle','screening','compiling','prompt_ready','queued','generating','running','ready','draft'];
function ids(rows,label,limit){
  if(!Array.isArray(rows)||rows.length>limit)fail(`${label}条目超过 ${limit} 项或不是列表，未裁剪导入`);
  const seen=new Set();for(const row of rows){if(!object(row)||typeof row.id!=='string'||!row.id.trim()||row.id.length>160||seen.has(row.id))fail(`${label}编号无效或重复`);seen.add(row.id);}return seen;
}
export function mergeStoryboardPackageRows(local,incoming,limit,label){
  ids(local,label,limit);ids(incoming,label,limit);const merged=new Map(local.map(row=>[row.id,structuredClone(row)]));for(const row of incoming)merged.set(row.id,structuredClone(row));
  if(merged.size>limit)fail(`${label}合并后超过 ${limit} 项，请先整理或分批导入；原数据未改动`);return [...merged.values()];
}
function assertRetained(before,after,label){const original=ids(before,label,100000),retained=new Set((after||[]).map(row=>row.id));if(original.size!==retained.size||[...original].some(id=>!retained.has(id)))fail(`${label}含当前版本无法完整保留的条目，未部分导入`);}

// Detached preparation only; normalize the combined libraries so incoming references can find local entries.
export function prepareStoryboardPackageDraft({settings,chat,incoming,images,collections,chatKey,namespace,sourceNamespace,now=Date.now}){
  if(!object(incoming)||!chatKey)fail('分镜包设置或目标聊天无效');const base=structuredClone(settings),raw=structuredClone(incoming),touched=new Set(),connectionReview=[];
  assertStoryboardSelectionRestoreScope(raw,{namespace,sourceNamespace});
  if(Object.hasOwn(raw,'comfyAutoEnabled')&&typeof raw.comfyAutoEnabled!=='boolean')fail('Comfy自动择流开关格式无效，未猜测开启状态');
  if(raw.source!==undefined&&!STORYBOARD_PROVIDER_REGISTRY[raw.source])fail('生图渠道不受当前版本支持');
  if(raw.profiles&&(!object(raw.profiles)||Object.keys(raw.profiles).some(key=>!STORYBOARD_PROVIDER_REGISTRY[key])))fail('绘制配置含不支持的渠道');
  const migrated=migrateStoryboardState(raw);
  for(const key of Object.keys(raw))if(Object.hasOwn(migrated,key)&&!STORYBOARD_ADDED_IMPORT_FIELDS.includes(key))raw[key]=migrated[key];
  if(!raw.connections&&Object.values(migrated.connections||{}).some(group=>group.presets?.length))raw.connections=migrated.connections;
  if(!raw.pipelineLogs&&raw.logs&&migrated.pipelineLogs?.length)raw.pipelineLogs=migrated.pipelineLogs;
  for(const key of STORYBOARD_IMPORT_FIELDS){if(!Object.hasOwn(raw,key)||key==='connections')continue;touched.add(key);
    base[key]=Object.hasOwn(limits,key)?mergeStoryboardPackageRows(base[key]||[],raw[key],limits[key],key):structuredClone(raw[key]);
  }
  // Old packages used routing as the count policy; retain that conservative migration explicitly.
  if(Object.hasOwn(raw,'generationPolicy')||Object.hasOwn(raw,'routing')){base.generationPolicy=normalizeStoryboardGenerationPolicy(raw.generationPolicy,raw.routing||{},raw.compositionPolicy);touched.add('generationPolicy');}
  // Imported display IDs are not authority to use a same-ID LLM profile on this installation.
  if(Object.hasOwn(raw,'promptCompiler'))base.promptCompiler={...base.promptCompiler,apiProfileId:settings.promptCompiler?.apiProfileId||'',connectionPresetId:settings.promptCompiler?.connectionPresetId||''};
  if(raw.profiles){base.profiles={...structuredClone(settings.profiles),...raw.profiles};}
  if(raw.connections){
    if(!object(raw.connections))fail('连接预设结构无效');base.connections=structuredClone(settings.connections);touched.add('connections');
    for(const [source,group] of Object.entries(raw.connections)){
      if(!STORYBOARD_PROVIDER_REGISTRY[source]||!object(group))fail('连接渠道不受当前版本支持');
      const local=base.connections[source]||createStoryboardDefaults().connections[source],rows=(group.presets||[]).map(row=>{
        const normalized=normalizeStoryboardConnectionProfile({...row,credentialId:''},source),previous=local.presets.find(item=>item.id===normalized.id);
        // A reused ID with a changed transport contract must never inherit a local secret reference.
        const sameTarget=storyboardConnectionsShareTarget(previous,row,source);
        connectionReview.push(storyboardConnectionRestoreReview(previous,{...row,id:normalized.id,name:normalized.name},source,{retained:sameTarget&&Boolean(previous.credentialId),active:local.activePresetId===normalized.id}));
        return {...normalized,credentialId:sameTarget?previous.credentialId:''};
      });
      local.presets=mergeStoryboardPackageRows(local.presets,rows,60,'连接预设');base.connections[source]=local;
      // Current draft and active preset are local choices; a portable file is not a credential switch.
    }
  }
  const transfer=new Set((raw.shotPlans||[]).map(row=>row.id));for(const plan of base.shotPlans||[]){if(!transfer.has(plan.id))continue;
    if((raw.shotPlans.find(row=>row.id===plan.id)?.archiveRef))fail('导入计划仍指向设备内归档，缺少原文');
    ids(plan.shots||[],'计划镜头',20);plan.chatKey=chatKey;plan.archiveRef='';plan.archiveVersion=0;plan.archivedAt=0;plan.autoGenerate=false;plan.manualReviewRequired=true;
    if(plan.messageRef)plan.messageRef={...plan.messageRef,chatKey};if(idle.includes(plan.status))plan.status='cancelled';
    for(const shot of plan.shots||[]){shot.requiresManualConfirmation=true;if(idle.includes(shot.status)){shot.status='cancelled';shot.error='从备份导入，未自动续跑';}}
  }
  const tasks=new Set((raw.taskStates||[]).map(row=>row.id));for(const task of base.taskStates||[]){if(!tasks.has(task.id))continue;task.chatKey=chatKey;if(task.messageRef)task.messageRef={...task.messageRef,chatKey};
    if(idle.includes(task.status)){task.status='cancelled';task.stage='cancelled';task.error='从备份导入，未自动续跑';task.finishedAt=now();}}
  const logs=new Set((raw.logs||[]).map(row=>row.id));for(const log of base.logs||[])if(logs.has(log.id)&&['queued','generating'].includes(log.status)){log.status='cancelled';log.error='从备份导入，原上游结果需核对，未重放请求';log.finishedAt=now();}
  const pipelines=new Set((raw.pipelineLogs||[]).map(row=>row.id));for(const log of base.pipelineLogs||[])if(pipelines.has(log.id)&&idle.includes(log.status)){log.status='cancelled';log.finishedAt=now();}
  for(const preset of raw.promptPresets||[])if(preset.items)ids(preset.items,'取景条目',50);
  // Carry the selected version, never transfer the user's previous permission to run automatic routing.
  if(['comfyAutoEnabled','comfyPoolSelection','comfyLibrarySelection'].some(key=>Object.hasOwn(raw,key))){base.comfyAutoEnabled=false;touched.add('comfyAutoEnabled');}
  const normalized=normalizeStoryboardState(base),draftSettings={};
  assertStoryboardAdditionalSettingsRetained(raw,normalized,{resetAutomatic:true});
  if(touched.has('connections'))for(const source of Object.keys(STORYBOARD_PROVIDER_REGISTRY)){
    normalized.connections[source].draft=structuredClone(settings.connections[source].draft);
    normalized.connections[source].activePresetId=settings.connections[source].activePresetId;
  }
  for(const key of touched){if(Object.hasOwn(limits,key))assertRetained(base[key],normalized[key],key);draftSettings[key]=structuredClone(normalized[key]);}
  // A normalizer can reorder fields or drop references; top-level rows are never silently lost.
  for(const [key,limit] of Object.entries(limits))if(touched.has(key)){const expected=mergeStoryboardPackageRows(settings[key]||[],raw[key],limit,key);assertRetained(expected,draftSettings[key],key);}
  const mergedImages=mergeStoryboardPackageRows(chat.storyboardImages||[],images,400,'阅片室成片');
  const mergedCollections=mergeStoryboardPackageRows(chat.storyboardCollections||[],collections,120,'阅片室合集');
  for(const row of mergedCollections)if(typeof row.name!=='string'||!row.name.trim()||row.name.length>80)fail('阅片室合集名称无效或超长');
  return {settings:draftSettings,chat:{storyboardImages:mergedImages,storyboardCollections:mergedCollections},connectionReview};
}
