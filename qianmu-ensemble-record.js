// Descriptive persisted data only. Loading a plan never imports a live execution session.
import {assertStoryboardStructureBytes} from './qianmu-storyboard-limits.js';
export const ENSEMBLE_RECOVERY_SCHEMA='qianmu.ensemble.recovery.v1';
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_recovery',submissionState:'not_submitted'});};
const fields=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u001f\u007f]/.test(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,160}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function normalizeEnsembleRecoveryScope(scope){
  const keys=['namespace','chatKey','planId','messageKey','revisionId'];
  if(!fields(scope,keys)||!keys.every(key=>text(scope[key],1024))||!/^st-user:\S/.test(scope.namespace))fail('镜组恢复缺少完整账户与楼层来源');
  return Object.fromEntries(keys.map(key=>[key,scope[key]]));
}
export function normalizeEnsembleRecoveryRecord(value){
  if(!fields(value,['schema','scope','selectionRevision','shots','executionAuthorized'])||value.schema!==ENSEMBLE_RECOVERY_SCHEMA||value.executionAuthorized!==false
    ||!id(value.selectionRevision)||!Array.isArray(value.shots)||!value.shots.length)fail('镜组恢复记录无效');
  // Keep the existing persisted-record byte ceiling, now before allocation.
  try{assertStoryboardStructureBytes(value,65536,'镜组恢复记录');}catch{fail('镜组恢复记录过大或结构无效');}
  const ids=new Set();const shots=value.shots.map((row,index)=>{
    if(!fields(row,['id','shotId','contentHash','schemeId','revision','bindingKey','reason'])||!id(row.id)||ids.has(row.id)||row.shotId!==`S${index+1}`
      ||!hash(row.contentHash)||!id(row.schemeId)||!id(row.revision)||!hash(row.bindingKey)||typeof row.reason!=='string'||row.reason.length>600
      ||row.reason!==row.reason.trim()||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.reason)||row.schemeId!=='current'&&!row.reason)fail('镜组恢复镜头不完整或顺序无效');
    ids.add(row.id);return {id:row.id,shotId:row.shotId,contentHash:row.contentHash,schemeId:row.schemeId,revision:row.revision,bindingKey:row.bindingKey,reason:row.reason};
  });
  const result={schema:ENSEMBLE_RECOVERY_SCHEMA,scope:normalizeEnsembleRecoveryScope(value.scope),selectionRevision:value.selectionRevision,shots,executionAuthorized:false};
  if(new TextEncoder().encode(JSON.stringify(result)).length>65536)fail('镜组恢复记录过大');return freeze(result);
}

// Preserve an invalid marker instead of silently restoring legacy routing.
// Older versions may not understand a future record; retaining the requirement
// keeps later execution from treating a missing/malformed receipt as opt-out.
export function retainEnsembleRecoveryRecord(value){
  try{return normalizeEnsembleRecoveryRecord(value);}
  catch{return Object.freeze({schema:ENSEMBLE_RECOVERY_SCHEMA,invalid:true,executionAuthorized:false});}
}
