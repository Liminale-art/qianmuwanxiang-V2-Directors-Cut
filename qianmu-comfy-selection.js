// Pure selection contract. This module cannot open storage, call an LLM, mutate a graph or authorize execution.
import { assertComfyRouteNamespace, normalizeComfyRouteBinding, comfyRouteBindingKey } from './qianmu-comfy-route-contract.js';
import { normalizeComfyReferenceSelection } from './qianmu-comfy-reference-contract.js';
import { COMFY_CLASSIFICATION_VALUES, normalizeComfyClassification, comfyClassificationChoices as choices } from './qianmu-comfy-classification.js';
export { COMFY_CLASSIFICATION_VALUES, normalizeComfyClassification } from './qianmu-comfy-classification.js';

export const COMFY_SELECTION_SCHEMA = 'qianmu.comfy.selection.v1';
export const COMFY_SELECTION_LIMIT = 32;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'comfy_selection_invalid',submissionState:'not_submitted'});};
const id=(value,label='编号')=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(value))fail(`${label}无效`);return value;};
const text=(value,max,label)=>{if(typeof value!=='string'||!value||value.length>max||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))fail(`${label}无效`);return value;};
const bool=(value,fallback=false)=>{if(value===undefined)return fallback;if(typeof value!=='boolean')fail('开关值无效');return value;};
async function digest(value) {
  if(!globalThis.crypto?.subtle)fail('当前环境不能核对候选配置，请使用 HTTPS 或本机地址');
  const data=new TextEncoder().encode(JSON.stringify(value));
  if(data.byteLength>256*1024)fail('候选配置过大，请拆分方案');
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',data))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function normalizeTarget(value,namespace) {
  if(!object(value)||value.providerId!=='comfy'||value.modelId!=='comfy-workflow'||value.parameterPresetId
    ||value.capabilityModelId!=null&&value.capabilityModelId!=='comfy-workflow')fail('候选须为独立固定 Comfy 工作流');
  const binding=normalizeComfyRouteBinding(value.comfyWorkflowBinding);
  if(binding.namespace!==namespace)fail('候选工作流属于另一账户');
  const references=normalizeComfyReferenceSelection(value.comfyReferences??null);
  if(references&&(references.namespace!==namespace||references.workflowHash!==binding.workflowHash))fail('候选参考图与固定版本不符');
  return {providerId:'comfy',modelId:'comfy-workflow',capabilityModelId:'comfy-workflow',
    connectionPresetId:value.connectionPresetId ? id(value.connectionPresetId,'连接预设') : '',parameterPresetId:'',
    comfyWorkflowBinding:binding,comfyCharacterEnabled:bool(value.comfyCharacterEnabled),comfyReferences:references};
}

export function normalizeComfyAutoPool(value) {
  if(!object(value)||value.schema!==COMFY_SELECTION_SCHEMA)fail('自动候选方案版本无效');
  const namespace=assertComfyRouteNamespace(value.namespace);
  if(!Array.isArray(value.candidates)||value.candidates.length>COMFY_SELECTION_LIMIT)fail('每个自动候选方案最多 32 项');
  const seen=new Set();
  const candidates=value.candidates.map(row=>{
    if(!object(row))fail('候选条目无效');const candidateId=id(row.id,'候选');if(seen.has(candidateId))fail('候选编号重复');seen.add(candidateId);
    const priority=row.priority??0;if(!Number.isInteger(priority)||priority<-100||priority>100)fail('候选优先级须在 -100 至 100');
    return {id:candidateId,enabled:bool(row.enabled,false),priority,target:normalizeTarget(row.target,namespace),classification:normalizeComfyClassification(row.classification)};
  });
  return {schema:COMFY_SELECTION_SCHEMA,namespace,id:id(value.id,'方案'),revision:id(value.revision,'方案版本'),enabled:bool(value.enabled,false),
    styleLock:bool(value.styleLock,true),candidates};
}

export async function comfyCandidateExecutionKey(candidate) {
  const target=candidate.target,binding=normalizeComfyRouteBinding(target.comfyWorkflowBinding),normalized=normalizeTarget(target,binding.namespace);
  // Include connection and reference/role choice; a matching graph name is not matching execution configuration.
  return digest([comfyRouteBindingKey(binding),normalized.connectionPresetId,normalized.comfyCharacterEnabled,normalized.comfyReferences]);
}

function requirement(value) {
  if(!object(value)||value.version!==1)fail('镜头需求版本无效');
  const valid=(key,allowed)=>value[key]===undefined||value[key]==='unknown'?'unknown':allowed.includes(value[key])?value[key]:fail('镜头需求分类无效');
  const count=value.visibleSubjects??null;
  if(count!==null&&(!Number.isInteger(count)||count<0||count>12))fail('镜头可见人物数无效');
  const subjects=value.subjectIds??[];
  if(!Array.isArray(subjects)||subjects.length>12||new Set(subjects).size!==subjects.length||count!==null&&subjects.length>count)fail('镜头可见人物身份无效');
  const subjectIds=subjects.map(value=>text(value,160,'可见人物')).sort();
  return {version:1,visualKind:valid('visualKind',COMFY_CLASSIFICATION_VALUES.visualKinds),visibleSubjects:count,subjectIds,
    narrativeLayer:valid('narrativeLayer',COMFY_CLASSIFICATION_VALUES.narrativeLayers),contentClass:valid('contentClass',COMFY_CLASSIFICATION_VALUES.contentClasses),
    promptFormats:choices(value.promptFormats,COMFY_CLASSIFICATION_VALUES.promptFormats,'已备提示格式')};
}
export function normalizeComfySceneScope(value,namespace) {
  if(value==null)return null;
  if(!object(value)||value.namespace!==namespace)fail('连续场景范围不属于当前账户');
  return {namespace,chatKey:text(value.chatKey,512,'聊天'),continuityId:id(value.continuityId,'连续场景'),
    narrativeLayer:COMFY_CLASSIFICATION_VALUES.narrativeLayers.includes(value.narrativeLayer)?value.narrativeLayer:fail('连续场景叙事层无效')};
}
const normalizeScope=normalizeComfySceneScope;
const scopeKey=scope=>JSON.stringify([scope.namespace,scope.chatKey,scope.continuityId,scope.narrativeLayer]);
export function normalizeComfySceneLock(value,namespace) {
  if(!object(value)||value.schema!==COMFY_SELECTION_SCHEMA||!object(value.scope)
    ||![value.poolKey,value.executionKey].every(key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)))fail('连续场景锁无效');
  return {schema:COMFY_SELECTION_SCHEMA,scope:normalizeScope(value.scope,namespace),poolKey:value.poolKey,candidateId:id(value.candidateId,'锁定候选'),executionKey:value.executionKey};
}
const poolKey=pool=>digest([pool.namespace,pool.id,pool.revision,pool.enabled,pool.styleLock,pool.candidates]);
export async function comfySelectionRequestKey(requirements,scope,namespace) {
  return digest([requirement(requirements),normalizeScope(scope,assertComfyRouteNamespace(namespace))]);
}
const outcome=(status,reason,details={})=>({schema:COMFY_SELECTION_SCHEMA,status,reason,executionAuthorized:false,...details});
function affinity(classification,request) {
  const rows=[['visualKinds',request.visualKind,4],['castSizes',request.visibleSubjects===null?'unknown':request.visibleSubjects===0?'none':request.visibleSubjects===1?'one':'many',2],['narrativeLayers',request.narrativeLayer,1]];
  return rows.reduce((score,[key,value,weight])=>score+(classification[key].includes(value)?weight:0),0);
}

export async function selectComfyWorkflow({pool:raw,namespace,requirements,eligibility,preparationId,scope:rawScope=null,lock=null,adultAllowed=false}) {
  const pool=normalizeComfyAutoPool(raw);assertComfyRouteNamespace(namespace);
  if(pool.namespace!==namespace)fail('自动候选方案属于另一账户');
  if(!pool.enabled)return outcome('disabled','pool_disabled');
  const request=requirement(requirements),scope=normalizeScope(rawScope,namespace);
  const capturedLock=pool.styleLock&&lock?normalizeComfySceneLock(lock,namespace):null;
  if(scope&&scope.narrativeLayer!==request.narrativeLayer)return outcome('review','scene_layer_mismatch');
  if(request.contentClass==='unknown')return outcome('review','content_unknown');
  if(request.contentClass==='adult'&&adultAllowed!==true)return outcome('review','content_not_authorized');
  if(!(eligibility instanceof Map))fail('缺少本次镜头的独立技术检查');
  id(preparationId,'本次准备');
  const checks=new Map(pool.candidates.map(candidate=>{const row=eligibility.get(candidate.id);return [candidate.id,row?{...row}:null];}));
  const requestKey=await comfySelectionRequestKey(request,scope,namespace),poolIdentity=await poolKey(pool);
  const candidates=[],excluded=[];
  for(const candidate of pool.candidates){
    const c=candidate.classification,key=await comfyCandidateExecutionKey(candidate),check=checks.get(candidate.id);let reason='';
    if(!candidate.enabled)reason='candidate_disabled';
    else if(!c.contentClasses.includes(request.contentClass))reason='content_not_declared';
    else if(!c.promptFormat||!request.promptFormats.includes(c.promptFormat))reason='prompt_format_unavailable';
    else if(c.maxSubjects!==null&&(request.visibleSubjects===null||request.visibleSubjects>c.maxSubjects))reason='subject_limit';
    else if(!check||check.executionKey!==key||check.preparationId!==preparationId||check.requestKey!==requestKey||check.automaticEligible!==true)reason='technical_gate';
    if(reason)excluded.push({id:candidate.id,reason});else candidates.push({candidate,key,score:affinity(c,request)});
  }
  if(capturedLock){
    if(!scope||scopeKey(capturedLock.scope)!==scopeKey(scope))return outcome('review','lock_scope_mismatch',{excluded});
    if(capturedLock.poolKey!==poolIdentity)return outcome('review','lock_pool_changed',{excluded});
    const locked=candidates.find(row=>row.key===capturedLock.executionKey&&row.candidate.id===capturedLock.candidateId);
    if(!locked)return outcome('review','locked_route_unavailable',{excluded});
    return choose(locked,pool,scope,poolIdentity,excluded,'scene_locked');
  }
  if(!candidates.length)return outcome('review','no_eligible_candidate',{excluded});
  candidates.sort((a,b)=>b.score-a.score||b.candidate.priority-a.candidate.priority||(a.candidate.id<b.candidate.id?-1:1));
  const first=candidates[0],tied=candidates.filter(row=>row.score===first.score&&row.candidate.priority===first.candidate.priority);
  if(tied.some(row=>row.key!==first.key))return outcome('review','ambiguous_match',{candidateIds:tied.map(row=>row.candidate.id),excluded});
  return choose(first,pool,scope,poolIdentity,excluded,'matched');
}
function choose(row,pool,scope,poolIdentity,excluded,reason) {
  const {candidate,key,score}=row;
  return outcome('selected',reason,{candidateId:candidate.id,target:candidate.target,score,excluded,
    proposedLock:pool.styleLock&&scope?{schema:COMFY_SELECTION_SCHEMA,scope,poolKey:poolIdentity,candidateId:candidate.id,executionKey:key}:null});
}
