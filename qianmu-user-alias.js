import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
import {validateAliasInput,validateAliasTargets} from './qianmu-user-alias-contract.js';
export const USER_ALIAS_SCHEMA='qianmu.storyboard.subject-map.v2';
export const USER_ALIAS_SCOPE='local-user-alias-resolution';
const fields=['category','subjectKey','scope','chatKey','archiveId','revision','updatedAt'];
const exact=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'character_archive_alias'});};
const bindingKey=row=>JSON.stringify([row.category,row.subjectKey,row.scope,row.chatKey]);
const order=(a,b)=>bindingKey(a)<bindingKey(b)?-1:bindingKey(a)>bindingKey(b)?1:0;
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
export function projectAliasBindings(rows,namespace){
  if(!account(namespace)||!Array.isArray(rows)||rows.length>2048)fail('USER地址核对范围无效');
  const keys=new Set();return rows.map(input=>{
    const stored=Object.hasOwn(input||{},'key');
    if(!exact(input,[...fields,...(stored?['key','namespace']:[])]))fail('绑定含未知字段，未丢弃原数据');
    const row=Object.fromEntries(fields.map(key=>[key,input[key]]));
    if(!['char','user'].includes(row.category)||typeof row.subjectKey!=='string'||!row.subjectKey||row.subjectKey.length>1024||/[\u0000-\u001f\u007f]/.test(row.subjectKey)
      ||!['default','chat'].includes(row.scope)||typeof row.chatKey!=='string'||row.chatKey.length>512||(row.scope==='default'?row.chatKey!=='':!row.chatKey||row.chatKey.trim()!==row.chatKey)
      ||typeof row.archiveId!=='string'||!/^[a-zA-Z0-9_-]{0,160}$/.test(row.archiveId)||typeof row.revision!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(row.revision)||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<0)fail('原绑定索引无效，请保留核对');
    const key=bindingKey(row);if(keys.has(key)||stored&&(input.namespace!==namespace||input.key!==JSON.stringify([namespace,row.category,row.subjectKey,row.scope,row.chatKey])))fail('原绑定重复或归属不符');keys.add(key);return row;
  }).sort(order);
}
export async function planUserAliases({namespace,chatHash,bindings,choices={},resolveTargets}){
  if(!hash(chatHash))fail('缺少当前聊天核对范围');validateAliasInput('user-alias-preview',{choices,offset:0});
  const before=projectAliasBindings(bindings,namespace),grouped=new Map();
  for(const row of before){if(row.category!=='user')continue;const targetKey=canonicalUserSubjectKey(row.subjectKey);if(!targetKey)continue;
    const key=JSON.stringify([targetKey,row.scope,row.chatKey]);if(!grouped.has(key))grouped.set(key,{key,targetKey,scope:row.scope,chatKey:row.chatKey,rows:[]});grouped.get(key).rows.push(row);
  }
  const groups=[...grouped.values()].filter(group=>group.rows.length>1||group.rows[0].subjectKey!==group.targetKey).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const expectedTargets=[...new Set(groups.map(row=>row.targetKey))].sort(),targets=validateAliasTargets(await resolveTargets(expectedTargets),expectedTargets);
  const affected=groups.flatMap(group=>group.rows).sort(order),sourceDigest=await digest({namespace,bindings:affected}),baselineDigest=await digest(before),keys=new Set(),lineage=[],selections=[],display=[];let unresolved=0;
  for(const group of groups){
    const groupId=await digest({namespace,key:group.key});keys.add(groupId);
    const candidates=await Promise.all(group.rows.map(async row=>({id:await digest(row),row})));
    const explicit=Object.hasOwn(choices,groupId)?candidates.find(row=>row.id===choices[groupId]):null;
    if(Object.hasOwn(choices,groupId)&&!explicit)fail('USER地址冲突选择已过期，请刷新核对');
    const conflict=new Set(group.rows.map(row=>row.archiveId)).size>1;
    const selected=explicit||(!conflict?(candidates.find(item=>item.row.subjectKey===group.targetKey)||candidates[0]):null);
    if(!selected)unresolved++;
    let next=null;if(selected){
      selections.push({groupId,candidateId:selected.id});
      next={...selected.row,subjectKey:group.targetKey,revision:'alias-'+await digest({namespace,sourceDigest,group:group.key,before:group.rows,selected:selected.id})};
      for(const source of group.rows)lineage.push({source,target:next});
    }
    for(const candidate of candidates)display.push({groupId,candidateId:candidate.id,targetKey:group.targetKey,sourceKey:candidate.row.subjectKey,scope:group.scope,chatKey:group.chatKey,archiveId:candidate.row.archiveId,selected:candidate.id===selected?.id,conflict});
  }
  if(Object.keys(choices).some(key=>!keys.has(key)))fail('USER地址选择已过期，请重新核对');
  const ready=groups.length>0&&unresolved===0&&targets.every(row=>row.present),removed=new Set(affected.map(bindingKey));
  const writes=[...new Map(lineage.map(pair=>[bindingKey(pair.target),pair.target])).values()].sort(order),after=[...before.filter(row=>!removed.has(bindingKey(row))),...writes].sort(order);
  let review=null;
  if(ready){
    const rows=[...new Map(affected.map(row=>[row.subjectKey,{category:'user',sourceKey:row.subjectKey,targetKey:canonicalUserSubjectKey(row.subjectKey)}])).values()].sort((a,b)=>a.sourceKey<b.sourceKey?-1:a.sourceKey>b.sourceKey?1:0);
    const core={schema:USER_ALIAS_SCHEMA,scope:USER_ALIAS_SCOPE,namespace,chatHash,sourceDigest,rows,lineage,selections,targets};review={...core,digest:await digest(core)};
    if(new TextEncoder().encode(JSON.stringify(review)).length>8*1048576)fail('原地址关系超过8MiB，未截断或改写');
  }
  return {namespace,chatHash,before,after,affected,writes,display,targets,groups:groups.length,unresolved,ready,review,digest:await digest({namespace,chatHash,baselineDigest,sourceDigest,choices,targets,review:review?.digest||null})};
}
export async function inspectUserAliasReview(value){
  if(!exact(value,['schema','scope','namespace','chatHash','sourceDigest','rows','lineage','selections','targets','digest'])||value.schema!==USER_ALIAS_SCHEMA||value.scope!==USER_ALIAS_SCOPE||!account(value.namespace)||![value.chatHash,value.sourceDigest,value.digest].every(hash)
    ||!Array.isArray(value.lineage)||!value.lineage.length||value.lineage.length>2048||!Array.isArray(value.selections)||value.selections.length>2048||!Array.isArray(value.rows)||value.rows.length>2048)fail('USER地址来源凭据结构无效');
  const choices={};for(const row of value.selections){if(!exact(row,['groupId','candidateId'])||!hash(row.groupId)||!hash(row.candidateId)||Object.hasOwn(choices,row.groupId))fail('USER地址来源选择无效');choices[row.groupId]=row.candidateId;}
  const bindings=value.lineage.map(pair=>{if(!exact(pair,['source','target']))fail('USER地址原绑定关系不完整');return pair.source;});
  const plan=await planUserAliases({namespace:value.namespace,chatHash:value.chatHash,bindings,choices,resolveTargets:async()=>value.targets});
  if(!plan.ready||!plan.review||await digest(value)!==await digest(plan.review))fail('USER地址来源凭据与原绑定或派生结果不符');return structuredClone(value);
}
