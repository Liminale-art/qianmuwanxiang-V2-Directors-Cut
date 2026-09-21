import {readEnsembleCompilerProof,ensembleShotContent} from './qianmu-ensemble-handoff.js?v=1.59.262';
export const ENSEMBLE_RECOVERY_SCHEMA='qianmu.ensemble.recovery.v1';
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_recovery',submissionState:'not_submitted'});};
const fields=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
function scopeOf(scope){
  const keys=['namespace','chatKey','planId','messageKey','revisionId'];
  if(!fields(scope,keys)||!keys.every(key=>text(scope[key],1024))||!/^st-user:\S/.test(scope.namespace))fail('镜组恢复缺少完整账户与楼层来源');
  return Object.fromEntries(keys.map(key=>[key,scope[key]]));
}
export function normalizeEnsembleRecoveryRecord(value){
  if(!fields(value,['schema','scope','selectionRevision','shots','executionAuthorized'])||value.schema!==ENSEMBLE_RECOVERY_SCHEMA||value.executionAuthorized!==false
    ||!id(value.selectionRevision)||!Array.isArray(value.shots)||!value.shots.length||value.shots.length>20)fail('镜组恢复记录无效');
  const ids=new Set();const shots=value.shots.map((row,index)=>{
    if(!fields(row,['id','shotId','contentHash','schemeId','revision','bindingKey','reason'])||!id(row.id)||ids.has(row.id)||row.shotId!==`S${index+1}`
      ||!hash(row.contentHash)||!id(row.schemeId)||!id(row.revision)||!hash(row.bindingKey)||typeof row.reason!=='string'||row.reason.length>600
      ||row.reason!==row.reason.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.reason)||row.schemeId!=='current'&&!row.reason)fail('镜组恢复镜头不完整或顺序无效');
    ids.add(row.id);return {id:row.id,shotId:row.shotId,contentHash:row.contentHash,schemeId:row.schemeId,revision:row.revision,bindingKey:row.bindingKey,reason:row.reason};
  });
  const result={schema:ENSEMBLE_RECOVERY_SCHEMA,scope:scopeOf(value.scope),selectionRevision:value.selectionRevision,shots,executionAuthorized:false};
  if(new TextEncoder().encode(JSON.stringify(result)).length>65536)fail('镜组恢复记录过大');return freeze(result);
}
const checkWith=guard=>async()=>{if(typeof guard!=='function'||await guard()===false)fail('镜组恢复来源已变化');};

// No file write occurs here. The host stores this descriptive record with its
// owned ordinary plan and confirms it before ending the compiler lifecycle.
export async function createEnsembleRecoveryRecord(result,{scope,guard}={}){
  const owner=scopeOf(scope),baseCheck=checkWith(guard),check=async()=>{await baseCheck();if(JSON.stringify(scopeOf(scope))!==JSON.stringify(owner))fail('镜组保存来源已变化');};await check();
  const proof=await readEnsembleCompilerProof(result,{guard:check});await check();
  if(proof.receipt.namespace!==owner.namespace||proof.receipt.chatKey!==owner.chatKey)fail('镜组结果不属于保存来源');
  const rows=[];
  for(let i=0;i<proof.shotIds.length;i++){const choice=proof.receipt.assignments[i];rows.push({id:proof.shotIds[i],shotId:choice.shotId,contentHash:await digest(proof.snapshots[i]),
    schemeId:choice.schemeId,revision:choice.revision,bindingKey:choice.bindingKey,reason:choice.reason});await check();}
  const latest=await readEnsembleCompilerProof(result,{guard:check});if(JSON.stringify(latest)!==JSON.stringify(proof))fail('保存恢复记录期间镜组结果已变化');
  return normalizeEnsembleRecoveryRecord({schema:ENSEMBLE_RECOVERY_SCHEMA,scope:owner,selectionRevision:proof.receipt.selectionRevision,shots:rows,executionAuthorized:false});
}

// Restored JSON is untrusted selection data. A fresh independently preflighted
// session plus exact ST read-back verification are mandatory; no LLM call,
// automatic retry, default-route fallback or image admission is performed here.
export async function restoreEnsembleRecoveryRecord(record,{scope,planned,session,guard,verifySaved}={}){
  const saved=normalizeEnsembleRecoveryRecord(record),owner=scopeOf(scope),check=checkWith(guard);
  if(JSON.stringify(saved.scope)!==JSON.stringify(owner)||!session||typeof session.resolve!=='function'||typeof session.resolveAssignment!=='function'
    ||typeof session.assertCurrent!=='function'||typeof verifySaved!=='function'||!Array.isArray(planned)||!planned.length||planned.length>saved.shots.length)fail('镜组恢复环境或来源不一致');
  const selected=[];let previous=-1;
  for(const shot of planned){const at=saved.shots.findIndex(row=>row.id===shot?.id);if(at<=previous||at<0)fail('恢复镜头重复、重排或不在原方案中');previous=at;selected.push(at);}
  const initial=planned.map(ensembleShotContent),sourceIdentity=JSON.stringify(owner);
  async function current(stored=false){
    await check();session.assertCurrent();
    if(JSON.stringify(scopeOf(scope))!==sourceIdentity||planned.length!==initial.length||planned.some((shot,i)=>ensembleShotContent(shot)!==initial[i]))fail('恢复过程中来源或镜头已变化');
    // The host verifies this exact normalized record in its confirmed ST plan;
    // cached JSON, a saved flag or a successful model call cannot replace it.
    if(stored&&await verifySaved(saved)!==true)fail('镜组方案尚未确认保存在当前ST楼层计划');
    await check();session.assertCurrent();
    if(JSON.stringify(scopeOf(scope))!==sourceIdentity||planned.length!==initial.length||planned.some((shot,i)=>ensembleShotContent(shot)!==initial[i]))fail('恢复核对期间来源或镜头已变化');
  }
  await current(true);
  for(let i=0;i<initial.length;i++){if(await digest(initial[i])!==saved.shots[selected[i]].contentHash)fail('恢复镜头内容与保存版本不一致');await current();}
  const receipt=session.resolve(saved.shots.map(row=>({shot_id:row.shotId,scheme_id:row.schemeId,reason:row.reason})),saved.shots.map(row=>row.shotId));
  if(receipt.namespace!==owner.namespace||receipt.chatKey!==owner.chatKey||receipt.selectionRevision!==saved.selectionRevision||receipt.executionAuthorized!==false
    ||receipt.assignments.length!==saved.shots.length||receipt.assignments.some((row,i)=>['shotId','schemeId','revision','bindingKey'].some(key=>row[key]!==saved.shots[i][key])))fail('已存风格、启用集合或绘制绑定已变化，请重新提取');
  const assignments=[];
  for(const index of selected){assignments.push(await session.resolveAssignment(receipt,saved.shots[index].shotId));await current();}
  await current(true);
  return Object.freeze({routes:freeze(assignments.map(row=>copy(row.route))),artistPresetIds:freeze(assignments.map(row=>row.artistPresetId)),
    schemes:freeze(assignments.map(row=>({shotId:row.shotId,schemeId:row.schemeId,bindingKey:row.bindingKey}))),executionAuthorized:false,assertCurrent:()=>current(true)});
}
