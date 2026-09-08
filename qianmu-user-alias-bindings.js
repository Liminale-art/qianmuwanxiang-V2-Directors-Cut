import {canonicalUserSubjectKey} from './qianmu-user-identity.js';
import {comfyLibraryBackupDigest as digest} from './qianmu-comfy-library-backup.js';
import {validateAliasInput} from './qianmu-user-alias-contract.js';

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

// Pure selection only: this neither checks a live ST directory nor authorizes a store write.
// Source selections/revisions are bound to BOTH the immutable package and its original evidence.
export async function selectUserAliasBindings({namespace,bindings,choices={},origin=null}){
  validateAliasInput('user-alias-preview',{choices,offset:0});
  if(origin!==null&&(!exact(origin,['sourceDigest','evidenceDigest'])||!hash(origin.sourceDigest)||!hash(origin.evidenceDigest)))fail('来源地址整理缺少原包与资料摘要');
  const before=projectAliasBindings(bindings,namespace),grouped=new Map();
  for(const row of before){if(row.category!=='user')continue;const targetKey=canonicalUserSubjectKey(row.subjectKey);if(!targetKey)continue;
    const key=JSON.stringify([targetKey,row.scope,row.chatKey]);if(!grouped.has(key))grouped.set(key,{key,targetKey,scope:row.scope,chatKey:row.chatKey,rows:[]});grouped.get(key).rows.push(row);
  }
  const groups=[...grouped.values()].filter(group=>group.rows.length>1||group.rows[0].subjectKey!==group.targetKey).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const affected=groups.flatMap(group=>group.rows).sort(order),sourceDigest=await digest({namespace,bindings:affected}),keys=new Set(),lineage=[],selections=[],display=[];let unresolved=0;
  for(const group of groups){
    const groupId=await digest({namespace,key:group.key,...(origin?{origin}:{})});keys.add(groupId);
    const candidates=await Promise.all(group.rows.map(async row=>({id:await digest(row),row})));
    const explicit=Object.hasOwn(choices,groupId)?candidates.find(row=>row.id===choices[groupId]):null;
    if(Object.hasOwn(choices,groupId)&&!explicit)fail('USER地址冲突选择已过期，请刷新核对');
    const conflict=new Set(group.rows.map(row=>row.archiveId)).size>1;
    const selected=explicit||(!conflict?(candidates.find(item=>item.row.subjectKey===group.targetKey)||candidates[0]):null);
    if(!selected)unresolved++;
    let next=null;if(selected){
      selections.push({groupId,candidateId:selected.id});
      next={...selected.row,subjectKey:group.targetKey,revision:(origin?'source-alias-':'alias-')+await digest({namespace,sourceDigest,group:group.key,before:group.rows,selected:selected.id,...(origin?{origin}:{})})};
      for(const source of group.rows)lineage.push({source,target:next});
    }
    for(const candidate of candidates)display.push({groupId,candidateId:candidate.id,targetKey:group.targetKey,sourceKey:candidate.row.subjectKey,scope:group.scope,chatKey:group.chatKey,archiveId:candidate.row.archiveId,selected:candidate.id===selected?.id,conflict});
  }
  if(Object.keys(choices).some(key=>!keys.has(key)))fail('USER地址选择已过期，请重新核对');
  const removed=new Set(affected.map(bindingKey)),writes=[...new Map(lineage.map(pair=>[bindingKey(pair.target),pair.target])).values()].sort(order);
  return {before,affected,writes,after:unresolved?null:[...before.filter(row=>!removed.has(bindingKey(row))),...writes].sort(order),display,lineage,selections,sourceDigest,groups:groups.length,unresolved};
}
