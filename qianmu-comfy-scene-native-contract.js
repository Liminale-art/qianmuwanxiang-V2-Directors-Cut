import {stAccountImmutableReference} from './qianmu-st-account-storage.js';
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
import {comfySceneScope,comfySceneScopeKey,inspectComfySceneRecord,changeComfySceneRecord,copyComfySceneStyleRecord,captureComfySceneAction,captureComfySceneStyleLink,comfySceneLockError} from './qianmu-comfy-scene-lock.js';
import {COMFY_SCENE_SNAPSHOT_SCHEMA,validateComfySceneSnapshot,comfySceneSnapshotBytes,sameComfySceneSnapshot,comfySceneSnapshotDigest} from './qianmu-comfy-scene-backup.js';
import {resolveReviewedComfyScene} from './qianmu-comfy-scene-review.js';
import {changeComfyBranchResult} from './qianmu-comfy-scene-branch-result.js';

export const COMFY_SCENE_NATIVE_SLOT='comfy-scene-runtime',COMFY_SCENE_EVENT_SLOT='comfy-scene-transition';
export const COMFY_SCENE_NATIVE_SCHEMA='qianmu.comfy.scene-runtime.v1',COMFY_SCENE_EVENT_SCHEMA='qianmu.comfy.scene-transition.v1';
export const sceneNativeFail=message=>{throw comfySceneLockError('native',message);};
export const scenePredecessorFail=message=>{throw comfySceneLockError('predecessor',message);};
export const sceneSame=sameComfySceneSnapshot,sceneHash=comfySceneSnapshotDigest,sceneBytes=comfySceneSnapshotBytes;
const fail=sceneNativeFail,exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),integer=v=>Number.isSafeInteger(v)&&v>=0;
export const sceneReference=(value,scope)=>stAccountImmutableReference(value,{scope,slot:COMFY_SCENE_EVENT_SLOT,maxBytes:128*1024+1024});
export function validateSceneRecord(record,scope){
  scope=comfySceneScope(scope);if(record===null)return null;const row={namespace:scope.namespace,chatKey:scope.chatKey,bytes:sceneBytes(record),record};
  validateComfySceneSnapshot({schema:COMFY_SCENE_SNAPSHOT_SCHEMA,namespace:scope.namespace,usage:{count:1,bytes:row.bytes,generation:0},rows:[{key:comfySceneScopeKey(scope),value:row}]});
  if(!sceneSame(record.scope,scope))fail('续场记录范围不符');return record;
}
export function sceneMutation(before,scope,action,at,source=null){
  if(action.type==='resolve')return resolveReviewedComfyScene(before,scope,action,at);
  validateSceneRecord(before,scope);
  if(action.type==='branch_result')return changeComfyBranchResult(before,scope,action,at);
  if(action.type==='clear'){
    if(!exact(action,['type']))fail('续场清理动作无效');
    const view=inspectComfySceneRecord(before,scope,at);if(view.pending||view.uncertain)fail('所选范围仍有在途或结果未明任务，未清理续场记录');return {row:null};
  }
  if(action.type==='link'){if(!exact(action,['type','request'])||!sceneSame(action.request,captureComfySceneStyleLink(action.request.sourceScope,action.request.targetScope,action.request)))fail('续场关联动作无效');validateSceneRecord(source,action.request.sourceScope);return copyComfySceneStyleRecord(source,before,action.request,at);}
  if(!sceneSame(action,captureComfySceneAction(action,scope)))fail('续场动作含非核定字段');
  return changeComfySceneRecord(before,scope,action,at);
}
export function validateSceneEvent(value,namespace){
  if(!exact(value,['schema','namespace','scope','record','before','action','source','at','generation','parents'])||value.schema!==COMFY_SCENE_EVENT_SCHEMA||value.namespace!==namespace
    ||!integer(value.generation)||!integer(value.at)||!Array.isArray(value.parents)||new Set(value.parents).size!==value.parents.length||value.parents.some(v=>!hash(v))||sceneBytes(value)>128*1024)fail('续场操作原件格式无效');
  const scope=comfySceneScope(value.scope);if(scope.namespace!==namespace)fail('续场操作属于另一账户');validateSceneRecord(value.record,scope);
  if(value.action===null){if(value.before!==null||value.source!==null||value.parents.length||value.record===null)fail('旧续场根来源不完整');}
  else{
    if(!value.action||typeof value.action!=='object')fail('续场操作证据无效');
    const result=sceneMutation(value.before,scope,value.action,value.at,value.source);if(!sceneSame(result.row,value.record))fail('续场操作前后记录不符合原生命周期');
    if(value.action.type!=='link'&&value.source!==null)fail('普通续场操作不能附带其他场景来源');
  }return value;
}
export function validateSceneProposal(value){
  if(!exact(value,['id','namespace','kind','generation','cleared','events','receipt','outcomeId'])||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(value.id)
    ||!integer(value.generation)||typeof value.cleared!=='boolean'||typeof value.outcomeId!=='string'||!Array.isArray(value.events)||!value.events.length||value.events.length>1024)fail('续场待保存操作格式无效');
  assertComfyRouteNamespace(value.namespace);const keys=new Set(),parents=new Set(),branch=value.kind==='branch_result';
  for(const event of value.events){validateSceneEvent(event,value.namespace);const key=comfySceneScopeKey(event.scope);
    if(!branch&&keys.has(key)||!event.action||event.generation!==value.generation+(value.cleared?1:0)||event.action.type!==value.kind||(value.kind==='clear')!==value.cleared)fail('续场操作集合或清理代数无效');keys.add(key);
    if(branch){const first=value.events[0],operation=event.action.operation,base=first.action.operation;
      if(keys.size!==1||event.parents.length!==1||parents.has(event.parents[0])||!event.action.heads.includes(event.parents[0])||!sceneSame(event.action.heads,first.action.heads)
        ||!sceneSame({...operation,expectedRevision:0},{...base,expectedRevision:0}))fail('分支结果必须来自同一任务及同一完整前序');parents.add(event.parents[0]);}
  }
  if(!['clear','branch_result'].includes(value.kind)&&value.events.length!==1)fail('普通续场操作仅可改变一个场景');
  const event=value.events[0];
  if(['reserve','begin','settle'].includes(value.kind)||branch&&event.action.operation.type==='settle'){
    const expected=value.kind==='reserve'?sceneMutation(event.before,event.scope,event.action,event.at,event.source).receipt:branch?event.action.operation.receipt:event.action.receipt;
    if(!expected||!sceneSame(value.receipt,expected))fail('续场待保存原票据不符');
  }else if(value.receipt!==null)fail('此续场操作不应携带执行票据');
  if(value.outcomeId&&value.kind!=='settle'&&!(branch&&value.receipt))fail('此续场操作不应携带结果回执');return value;
}
export const sceneLeaves=entry=>{if(!entry)return [];const used=new Set(entry.versions.flatMap(v=>v.parents));return entry.versions.filter(v=>!used.has(v.digest));};
export function emptySceneIndex(namespace){return {schema:COMFY_SCENE_NATIVE_SCHEMA,namespace,revision:0,generation:0,cleared:false,entries:[],sources:[]};}
export function validateSceneMetadata(value,scope){
  if(!exact(value,['digest','stateHash','stateBytes','reference','parents'])||!hash(value.digest)||!hash(value.stateHash)||!integer(value.stateBytes)||value.stateBytes>32768
    ||!Array.isArray(value.parents)||new Set(value.parents).size!==value.parents.length||value.parents.some(parent=>!hash(parent)))fail('续场操作元数据无效');
  sceneReference(value.reference,scope);return value;
}
export function validateSceneIndex(value,namespace,scope){
  assertComfyRouteNamespace(namespace);
  if(!exact(value,['schema','namespace','revision','generation','cleared','entries','sources'])||value.schema!==COMFY_SCENE_NATIVE_SCHEMA||value.namespace!==namespace||!integer(value.revision)||!integer(value.generation)||typeof value.cleared!=='boolean'
    ||!Array.isArray(value.entries)||value.entries.length>8192||!Array.isArray(value.sources)||value.sources.length>256||new Set(value.sources).size!==value.sources.length||value.sources.some(v=>!hash(v))||sceneBytes(value)>8*1024*1024)fail('续场运行目录结构或账户无效');
  const keys=new Set();let live=0,total=0;for(const entry of value.entries){
    if(!exact(entry,['scope','blocked','versions'])||typeof entry.blocked!=='boolean'||!Array.isArray(entry.versions)||!entry.versions.length||entry.versions.length>8192)fail('续场版本目录无效');
    const s=comfySceneScope(entry.scope),key=comfySceneScopeKey(s);if(!sceneSame(s,entry.scope)||s.namespace!==namespace||keys.has(key))fail('续场范围重复或账户不符');keys.add(key);
    const seen=new Set();for(const v of entry.versions){validateSceneMetadata(v,scope);if(seen.has(v.digest)||v.parents.some(p=>!seen.has(p)))fail('续场操作前序不完整');seen.add(v.digest);}
    const leaves=sceneLeaves(entry);if(entry.blocked||leaves.some(v=>v.stateBytes>0)){live++;total+=Math.max(...leaves.map(v=>v.stateBytes));}
  }if(live>1024||total>4*1024*1024)fail('续场记录超过原有场景数量或容量');return value;
}
export async function validateSceneEventLink(event,entry,meta){
  validateSceneEvent(event,event.namespace);
  if(event.action?.type==='branch_result'&&(event.parents.length!==1||!event.action.heads.includes(event.parents[0])))fail('分支结果没有准确原前序');
  if(!sceneSame(event.scope,entry.scope)||!sceneSame(event.parents,meta.parents)||await sceneHash(event)!==meta.digest||await sceneHash(event.record)!==meta.stateHash||(event.record===null?0:sceneBytes(event.record))!==meta.stateBytes)fail('续场原件与目录不符');
  if(event.action?.type==='resolve'){
    if(!sceneSame(event.parents,event.before.map(row=>row.digest)))fail('续场核对未覆盖全部原前序');
    for(const branch of event.before)if(entry.versions.find(v=>v.digest===branch.digest)?.stateHash!==await sceneHash(branch.record))fail('续场核对的完整原件不符');
  }
  else if(event.parents.length){const beforeHash=await sceneHash(event.before);if(event.parents.some(id=>entry.versions.find(v=>v.digest===id)?.stateHash!==beforeHash))fail('续场操作原前序状态不符');}
  else if(event.action!==null&&event.before!==null)fail('非空续场操作缺少前序');
  return event;
}
