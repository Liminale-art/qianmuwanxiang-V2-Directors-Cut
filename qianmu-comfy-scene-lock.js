// Pure lifecycle for a program-confirmed scene. No scope inference, workflow execution or storage.
import {normalizeComfySceneScope,normalizeComfySceneLock} from './qianmu-comfy-selection.js';
import {assertComfyRouteNamespace} from './qianmu-comfy-route-contract.js';
export const COMFY_SCENE_LOCK_SCHEMA='qianmu.comfy.scene-lock.v1';
export const COMFY_SCENE_RESERVATION_MS=10*60_000;
export const COMFY_SCENE_HOLDER_LIMIT=32;
const copy=value=>JSON.parse(JSON.stringify(value));
export const comfySceneLockError=(code,message)=>Object.assign(new Error(message),{code:`comfy_scene_${code}`,submissionState:'not_submitted'});
const fail=(code,message)=>{throw comfySceneLockError(code,message);};
const text=(value,label,max=160)=>{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value))fail('identity',`${label}无效`);return value;};
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const time=at=>{if(!integer(at)||at>Number.MAX_SAFE_INTEGER-COMFY_SCENE_RESERVATION_MS)fail('time','续场记录时间无效');return at;};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const label=value=>({planId:typeof value?.planId==='string'?value.planId.slice(0,240):'',floor:Number.isInteger(value?.floor)&&value.floor>=0?value.floor:null,
  workflowName:typeof value?.workflowName==='string'?value.workflowName.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,80):'',
  ...(typeof value?.sceneTitle==='string'&&value.sceneTitle.trim()?{sceneTitle:value.sceneTitle.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80)}:{})});
export function comfySceneScope(scope){const ns=assertComfyRouteNamespace(scope?.namespace);return normalizeComfySceneScope(scope,ns);}
export const comfySceneScopeKey=scope=>{const s=comfySceneScope(scope);return JSON.stringify([s.namespace,s.chatKey,s.continuityId,s.narrativeLayer]);};
function sceneStyleOrigin(value,scope){
  if(value==null)return null;
  const sourceScope=comfySceneScope(value.sourceScope);
  if(value.kind!=='explicit_link'||!sourceScope||sourceScope.namespace!==scope.namespace||sourceScope.chatKey!==scope.chatKey
    ||sourceScope.narrativeLayer!==scope.narrativeLayer||same(sourceScope,scope)||!integer(value.sourceRevision)||value.sourceRevision<1
    ||!integer(value.sourceFloor)||!integer(value.targetFloor)||value.sourceFloor>=value.targetFloor)fail('corrupt','续场来源记录无效');
  return {kind:'explicit_link',sourceScope,sourceRevision:value.sourceRevision,sourceFloor:value.sourceFloor,targetFloor:value.targetFloor,linkedAt:time(value.linkedAt)};
}
// This is an explicit style copy, never a recursive alias or a generation permission.
export function captureComfySceneStyleLink(sourceScope,targetScope,request){
  sourceScope=comfySceneScope(sourceScope);targetScope=comfySceneScope(targetScope);
  if(!sourceScope||!targetScope||sourceScope.namespace!==targetScope.namespace||sourceScope.chatKey!==targetScope.chatKey
    ||sourceScope.narrativeLayer!==targetScope.narrativeLayer||same(sourceScope,targetScope))fail('scope','仅可关联本聊天同一叙事层的其他场景');
  if(!integer(request?.expectedSourceRevision)||request.expectedSourceRevision<1||!integer(request?.expectedRevision)
    ||!integer(request?.expectedGeneration))fail('revision','续场关联版本无效');
  const targetLabel=label(request.label);
  if(!targetLabel.planId||targetLabel.floor===null)fail('scope','请先提取目标楼层的镜头');
  return {sourceScope,targetScope,expectedSourceRevision:request.expectedSourceRevision,expectedRevision:request.expectedRevision,
    expectedGeneration:request.expectedGeneration,label:targetLabel};
}
export function copyComfySceneStyleRecord(sourceValue,targetValue,input,at=Date.now()){
  const request=captureComfySceneStyleLink(input.sourceScope,input.targetScope,input),source=normalizeComfySceneRecord(sourceValue,request.sourceScope),target=normalizeComfySceneRecord(targetValue,request.targetScope);
  time(at);
  if(source.revision!==request.expectedSourceRevision||target.revision!==request.expectedRevision)fail('conflict','续场来源或目标已变化，请重新选择');
  const from=inspectComfySceneRecord(sourceValue,request.sourceScope,at),to=inspectComfySceneRecord(targetValue,request.targetScope,at);
  if(!from.lock||!source.established||from.pending||from.uncertain)fail('busy','来源场景须已结束且结果明确，请先核查原任务');
  if(to.lock||to.pending||to.uncertain)fail('busy','目标场景已有风格或任务，请先核对并解锁');
  if(source.label.floor===null||source.label.floor>=request.label.floor)fail('scope','请选择目标楼层之前的续场记录');
  if(target.revision===Number.MAX_SAFE_INTEGER)fail('revision','续场版本已满，请整理记录');
  target.revision++;target.lockRevision=target.revision;target.updatedAt=at;target.established=true;target.holders=[];
  target.lock={...copy(from.lock),scope:copy(request.targetScope)};
  target.label={...request.label,workflowName:source.label.workflowName};
  target.styleOrigin=sceneStyleOrigin({kind:'explicit_link',sourceScope:request.sourceScope,sourceRevision:source.revision,
    sourceFloor:source.label.floor,targetFloor:request.label.floor,linkedAt:at},request.targetScope);
  return {row:target};
}
export async function createComfyBatchSceneScopes({namespace,chatKey,batchKey,groups,guard=async()=>{}}){
  namespace=assertComfyRouteNamespace(namespace);text(chatKey,'聊天',512);text(batchKey,'本批次',240);
  if(!Array.isArray(groups)||!groups.length||groups.length>32||!globalThis.crypto?.subtle)fail('scope','缺少本批次已划分的场景范围');
  const captured=copy(groups),source=JSON.stringify(groups),scopes=new Map();await guard();
  for(const [index,group] of captured.entries()){
    if(!Array.isArray(group.shotIds)||!group.shotIds.length||group.shotIds.length>32)fail('scope','场景缺少镜头编号');
    const fp=group.sceneFingerprint || {},narrativeLayer=fp.narrativeLayer || 'present';
    const content=JSON.stringify([namespace,chatKey,batchKey,index,text(group.id,'分组'),String(fp.sceneId||'').slice(0,160),String(fp.location||'').slice(0,1000),String(fp.time||'').slice(0,240),narrativeLayer]);
    const continuityId=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');await guard();
    const scope=comfySceneScope({namespace,chatKey,continuityId,narrativeLayer});
    for(const id of group.shotIds){text(id,'镜头');if(scopes.has(id))fail('scope','本批次镜头重复归组');scopes.set(id,scope);}
  }
  if(source!==JSON.stringify(groups))fail('scope','本批次场景已变化，请重新准备');return scopes;
}
export async function createComfyDraftSceneScopes({namespace,chatKey,planId,revisionId,groups,shots,guard=async()=>{}}){
  namespace=assertComfyRouteNamespace(namespace);text(chatKey,'聊天',512);text(planId,'取景计划',240);text(revisionId,'正文版本',80);
  if(!Array.isArray(shots)||!shots.length||shots.length>32||!globalThis.crypto?.subtle)fail('scope','请先提取当前楼层');
  const read=()=>JSON.stringify([namespace,chatKey,planId,revisionId,groups,shots.map(shot=>({id:shot.id,prompt:shot.prompt,negative:shot.negative,shotSpec:shot.shotSpec}))]);
  const captured=read(),bytes=new TextEncoder().encode(captured);if(bytes.byteLength>2*1024*1024)fail('capacity','本次续场草稿过大，请拆分取景');
  await guard();const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');await guard();
  const scopes=await createComfyBatchSceneScopes({namespace,chatKey,batchKey:`draft_${digest}`,groups,guard});
  if(scopes.size!==shots.length||shots.some(shot=>!scopes.has(shot.id))||read()!==captured)fail('scope','取景草稿已变化，请重新选择续场');
  return scopes;
}
export function normalizeComfySceneRecord(value,scope){
  scope=comfySceneScope(scope);
  if(value==null)return {schema:COMFY_SCENE_LOCK_SCHEMA,scope,revision:0,lockRevision:0,lock:null,label:label(null),established:false,holders:[],updatedAt:0};
  if(value.schema!==COMFY_SCENE_LOCK_SCHEMA||!same(comfySceneScope(value.scope),scope)||!integer(value.revision)||value.revision<1
    ||!integer(value.lockRevision)||value.lockRevision>value.revision||typeof value.established!=='boolean'||!Array.isArray(value.holders)||value.holders.length>COMFY_SCENE_HOLDER_LIMIT)fail('corrupt','续场锁记录损坏，请先核对原任务');
  const lock=value.lock==null?null:normalizeComfySceneLock(value.lock,scope.namespace);
  if(lock&&!same(lock.scope,scope)||!lock&&(value.holders.length||value.established))fail('corrupt','续场锁范围不匹配');
  const ids=new Set();
  const holders=value.holders.map(row=>{
    const id=text(row.attemptId,'任务');if(ids.has(id))fail('corrupt','续场任务重复');ids.add(id);
    if(!['reserved','submitting','uncertain'].includes(row.status))fail('corrupt','续场任务状态无效');
    const until=time(row.expiresAt);if(row.status!=='reserved'&&until!==0)fail('corrupt','在途续场任务不能自动过期');
    return {attemptId:id,ownerId:text(row.ownerId,'页面'),token:text(row.token,'预留票据'),status:row.status,expiresAt:until};
  });
  const styleOrigin=sceneStyleOrigin(value.styleOrigin,scope);
  if(styleOrigin&&!lock)fail('corrupt','已解除风格仍残留续场来源');
  if(styleOrigin&&(!value.established||styleOrigin.targetFloor!==label(value.label).floor))fail('corrupt','续场来源与目标楼层不符');
  return {schema:COMFY_SCENE_LOCK_SCHEMA,scope,revision:value.revision,lockRevision:value.lockRevision,lock,label:label(value.label),established:value.established,holders,updatedAt:time(value.updatedAt),...(styleOrigin?{styleOrigin}:{})};
}
export function normalizeComfySceneReceipt(value){
  if(value?.schema!==COMFY_SCENE_LOCK_SCHEMA)fail('receipt','本镜缺少续场预留票据');
  return {schema:COMFY_SCENE_LOCK_SCHEMA,scope:comfySceneScope(value.scope),attemptId:text(value.attemptId,'任务'),ownerId:text(value.ownerId,'页面'),token:text(value.token,'预留票据')};
}
export function captureComfySceneAction(action,scope){
  scope=comfySceneScope(scope);
  if(action?.type==='reserve'){
    if(!integer(action.expectedRevision))fail('revision','续场版本无效');
    const lock=normalizeComfySceneLock(action.lock,scope.namespace);if(!same(lock.scope,scope))fail('scope','所选工作流不属于本场景');
    return {type:'reserve',lock,label:label(action.label),expectedRevision:action.expectedRevision,attemptId:text(action.attemptId,'任务'),ownerId:text(action.ownerId,'页面'),token:text(action.token,'预留票据')};
  }
  if(action?.type==='unlock'){
    if(!integer(action.expectedRevision))fail('revision','续场版本无效');
    return {type:'unlock',expectedRevision:action.expectedRevision,acknowledgeUncertain:action.acknowledgeUncertain===true};
  }
  if(action?.type==='orphan'){
    if(!integer(action.expectedRevision))fail('revision','续场版本无效');
    return {type:'orphan',expectedRevision:action.expectedRevision,ownerId:text(action.ownerId,'原页面')};
  }
  if(action?.type==='begin'||action?.type==='settle'){
    const receipt=normalizeComfySceneReceipt(action.receipt);if(!same(receipt.scope,scope))fail('scope','续场票据不属于本场景');
    if(action.type==='settle'&&!['not_submitted','rejected','unknown','accepted','succeeded'].includes(action.outcome))fail('outcome','续场任务结果无效');
    return {type:action.type,receipt,...(action.type==='settle'?{outcome:action.outcome}:{})};
  }
  fail('action','续场操作无效');
}
export function inspectComfySceneRecord(value,scope,at=Date.now()){
  const row=normalizeComfySceneRecord(value,scope);time(at);
  const active=row.holders.filter(holder=>holder.status!=='reserved'||holder.expiresAt>at);
  return {revision:row.revision,lockRevision:row.lockRevision,lock:row.established||active.length?copy(row.lock):null,established:row.established,
    pending:active.filter(holder=>holder.status!=='uncertain').length,uncertain:active.filter(holder=>holder.status==='uncertain').length,
    scope:copy(row.scope),label:copy(row.label),updatedAt:row.updatedAt,...(row.styleOrigin?{styleOrigin:copy(row.styleOrigin)}:{})};
}
export function changeComfySceneRecord(value,scope,action,at=Date.now()){
  const row=normalizeComfySceneRecord(value,scope);action=captureComfySceneAction(action,scope);time(at);
  const changed=()=>{if(row.revision===Number.MAX_SAFE_INTEGER)fail('revision','续场版本已满，请整理记录');row.revision++;row.updatedAt=at;return {row};};
  if(action.type==='reserve'){
    const lock=normalizeComfySceneLock(action.lock,row.scope.namespace);
    if(!same(lock.scope,row.scope))fail('scope','所选工作流不属于本场景');
    const attemptId=text(action.attemptId,'任务'),ownerId=text(action.ownerId,'页面'),token=text(action.token,'预留票据');
    const old=row.holders.find(holder=>holder.attemptId===attemptId);
    if(old){
      if(old.ownerId!==ownerId||!same(row.lock,lock)||old.status!=='reserved'||old.expiresAt<=at)fail('conflict','本镜续场预留已变化，请重新准备');
      return {row,receipt:{schema:COMFY_SCENE_LOCK_SCHEMA,scope:copy(row.scope),attemptId,ownerId,token:old.token}};
    }
    if(!integer(action.expectedRevision)||row.revision!==action.expectedRevision)fail('conflict','续场已被另一任务更新，请重新准备');
    row.holders=row.holders.filter(holder=>holder.status!=='reserved'||holder.expiresAt>at);
    if(!row.established&&!row.holders.length)row.lock=null;
    if(row.lock&&!same(row.lock,lock))fail('conflict','本场景已锁定另一工作流，请核对或手动解锁');
    if(row.holders.length>=COMFY_SCENE_HOLDER_LIMIT)fail('capacity','本场景待处理任务过多，请先完成或核查原任务');
    if(!row.lock){row.lockRevision=row.revision+1;row.label=label(action.label);}
    row.lock=lock;row.holders.push({attemptId,ownerId,token,status:'reserved',expiresAt:at+COMFY_SCENE_RESERVATION_MS});
    return {...changed(),receipt:{schema:COMFY_SCENE_LOCK_SCHEMA,scope:copy(row.scope),attemptId,ownerId,token}};
  }
  // Invoked only while the coordinator holds the original owner's now-vacant Web Lock.
  // A crashed submitter becomes unknown, never permission to silently release or resend.
  if(action.type==='orphan'){
    if(row.revision!==action.expectedRevision)fail('conflict','续场状态已变化，请重新核对');
    let modified=false;
    row.holders=row.holders.filter(holder=>{
      if(holder.ownerId!==action.ownerId||holder.status==='uncertain')return true;
      modified=true;if(holder.status==='reserved')return false;
      holder.status='uncertain';holder.expiresAt=0;row.established=true;return true;
    });
    if(!modified)return {row};
    if(!row.established&&!row.holders.length){row.lock=null;row.lockRevision=row.revision+1;}
    return changed();
  }
  if(action.type==='unlock'){
    if(!integer(action.expectedRevision)||row.revision!==action.expectedRevision)fail('conflict','续场状态已变化，请重新核对');
    const active=row.holders.filter(holder=>holder.status!=='reserved'||holder.expiresAt>at);
    if(active.some(holder=>holder.status!=='uncertain'))fail('busy','本场景仍有待提交或在途任务，暂不能解锁');
    if(active.length&&action.acknowledgeUncertain!==true)fail('uncertain','本场景有结果未明任务，请先核查渠道记录');
    row.lock=null;row.lockRevision=row.revision+1;row.established=false;row.holders=[];delete row.styleOrigin;return changed(); // Keep the revision tombstone: no ABA after unlock.
  }
  const receipt=normalizeComfySceneReceipt(action.receipt);
  if(!same(receipt.scope,row.scope))fail('scope','续场票据不属于本场景');
  const holder=row.holders.find(item=>item.attemptId===receipt.attemptId&&item.ownerId===receipt.ownerId&&item.token===receipt.token);
  if(!holder)fail('receipt','续场预留已失效，未继续提交');
  if(action.type==='begin'){
    if(holder.status==='uncertain'||holder.status==='reserved'&&holder.expiresAt<=at)fail('receipt','续场预留过期或结果未明，请先核查原任务');
    if(holder.status==='submitting')return {row};
    holder.status='submitting';holder.expiresAt=0;return changed();
  }
  if(action.type==='settle'){
    if(!['not_submitted','rejected','unknown','accepted','succeeded'].includes(action.outcome))fail('outcome','续场任务结果无效');
    if(['unknown','accepted'].includes(action.outcome)){holder.status='uncertain';holder.expiresAt=0;row.established=true;}
    else {
      if(holder.status==='uncertain'&&action.outcome==='not_submitted')fail('uncertain','不能把结果未明任务自动改为未提交');
      if(action.outcome==='succeeded')row.established=true;
      row.holders=row.holders.filter(item=>item!==holder);
      if(!row.established&&!row.holders.length){row.lock=null;row.lockRevision=row.revision+1;}
    }
    return changed();
  }
  fail('action','续场操作无效');
}
