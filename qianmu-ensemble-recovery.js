import {readEnsembleCompilerProof,ensembleShotContent} from './qianmu-ensemble-handoff.js?v=1.59.362';
import {ensembleStyleOrigins} from './qianmu-ensemble-origin.js';
import {ensembleSelectionStages} from './qianmu-ensemble-diagnostics.js';
import {normalizeEnsembleRecoveryScope as scopeOf,normalizeEnsembleRecoveryRecord,ENSEMBLE_RECOVERY_SCHEMA} from './qianmu-ensemble-record.js';
export {normalizeEnsembleRecoveryRecord,ENSEMBLE_RECOVERY_SCHEMA} from './qianmu-ensemble-record.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=message=>{throw Object.assign(Error(message),{code:'ensemble_recovery',submissionState:'not_submitted'});};
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
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
    origins:ensembleStyleOrigins(receipt,selected.map(index=>saved.shots[index].shotId)),
    stages:ensembleSelectionStages(receipt,session.catalogue,selected.map(index=>saved.shots[index].shotId)),
    schemes:freeze(assignments.map(row=>({shotId:row.shotId,schemeId:row.schemeId,bindingKey:row.bindingKey}))),executionAuthorized:false,assertCurrent:()=>current(true)});
}
