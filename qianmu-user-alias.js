import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
import {validateAliasInput,validateAliasTargets} from './qianmu-user-alias-contract.js';
import {selectUserAliasBindings} from './qianmu-user-alias-bindings.js';
export {projectAliasBindings} from './qianmu-user-alias-bindings.js';
export const USER_ALIAS_SCHEMA='qianmu.storyboard.subject-map.v2';
export const USER_ALIAS_SCOPE='local-user-alias-resolution';
const exact=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'character_archive_alias'});};
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
export async function planUserAliases({namespace,chatHash,bindings,choices={},resolveTargets}){
  if(!hash(chatHash))fail('缺少当前聊天核对范围');validateAliasInput('user-alias-preview',{choices,offset:0});
  const selection=await selectUserAliasBindings({namespace,bindings,choices}),{before,affected,writes,after,display,lineage,selections,sourceDigest,groups,unresolved}=selection;
  const expectedTargets=[...new Set(display.map(row=>row.targetKey))].sort(),targets=validateAliasTargets(await resolveTargets(expectedTargets),expectedTargets);
  const baselineDigest=await digest(before),ready=groups>0&&unresolved===0&&targets.every(row=>row.present);
  let review=null;
  if(ready){
    const rows=[...new Map(affected.map(row=>[row.subjectKey,{category:'user',sourceKey:row.subjectKey,targetKey:canonicalUserSubjectKey(row.subjectKey)}])).values()].sort((a,b)=>a.sourceKey<b.sourceKey?-1:a.sourceKey>b.sourceKey?1:0);
    const core={schema:USER_ALIAS_SCHEMA,scope:USER_ALIAS_SCOPE,namespace,chatHash,sourceDigest,rows,lineage,selections,targets};review={...core,digest:await digest(core)};
    if(new TextEncoder().encode(JSON.stringify(review)).length>8*1048576)fail('原地址关系超过8MiB，未截断或改写');
  }
  return {namespace,chatHash,before,after,affected,writes,display,targets,groups,unresolved,ready,review,digest:await digest({namespace,chatHash,baselineDigest,sourceDigest,choices,targets,review:review?.digest||null})};
}
export async function inspectUserAliasReview(value){
  if(!exact(value,['schema','scope','namespace','chatHash','sourceDigest','rows','lineage','selections','targets','digest'])||value.schema!==USER_ALIAS_SCHEMA||value.scope!==USER_ALIAS_SCOPE||!account(value.namespace)||![value.chatHash,value.sourceDigest,value.digest].every(hash)
    ||!Array.isArray(value.lineage)||!value.lineage.length||value.lineage.length>2048||!Array.isArray(value.selections)||value.selections.length>2048||!Array.isArray(value.rows)||value.rows.length>2048)fail('USER地址来源凭据结构无效');
  const choices={};for(const row of value.selections){if(!exact(row,['groupId','candidateId'])||!hash(row.groupId)||!hash(row.candidateId)||Object.hasOwn(choices,row.groupId))fail('USER地址来源选择无效');choices[row.groupId]=row.candidateId;}
  const bindings=value.lineage.map(pair=>{if(!exact(pair,['source','target']))fail('USER地址原绑定关系不完整');return pair.source;});
  const plan=await planUserAliases({namespace:value.namespace,chatHash:value.chatHash,bindings,choices,resolveTargets:async()=>value.targets});
  if(!plan.ready||!plan.review||await digest(value)!==await digest(plan.review))fail('USER地址来源凭据与原绑定或派生结果不符');return structuredClone(value);
}
