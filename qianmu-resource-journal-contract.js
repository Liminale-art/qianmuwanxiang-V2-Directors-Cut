const fail=message=>{throw Object.assign(Error(message),{code:'storyboard_package_journal',submissionState:'not_submitted'});};
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const resourceOrder=kind=>kind==='bundle'?['prepared','originals','workflows','pools','metadata','vibes','verified']:['prepared','originals','workflows','metadata','verified'];
export function validateResourceRestoreCheckpoint(row){
  const keys=['key','version','namespace','kind','sourceDigest','planDigest','phase','revision','createdAt','updatedAt',...(row?.kind==='bundle'?['chatHash','environmentDigest','subjectMappingDigest']:[])];
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(name=>!keys.includes(name))||row.version!==1||!account(row.namespace)||!['characters','bundle'].includes(row.kind)
    ||(row.kind==='bundle'&&(!hash(row.chatHash)||['environmentDigest','subjectMappingDigest'].some(field=>Object.hasOwn(row,field)&&!hash(row[field]))))||row.key!==JSON.stringify([row.namespace,row.kind])||!hash(row.sourceDigest)||!hash(row.planDigest)||!resourceOrder(row.kind).includes(row.phase)
    ||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<row.createdAt)fail('资源恢复记录损坏，请保留原备份核对');
  return row;
}
export function prepareResourceCheckpoint(descriptor,previous,current,stamp){
  const row=structuredClone(validateResourceRestoreCheckpoint({...descriptor,key:JSON.stringify([descriptor.namespace,descriptor.kind]),version:1,phase:'prepared',revision:1,createdAt:stamp,updatedAt:stamp}));
  if(current)validateResourceRestoreCheckpoint(current);if(previous)validateResourceRestoreCheckpoint(previous);
  if(!same(current||null,previous||null))fail('资源恢复记录已被另一页面修改，请重新核对');
  if(current&&(current.sourceDigest!==row.sourceDigest||current.chatHash!==row.chatHash)&&current.phase!=='verified')fail('本账户有未完成的资源恢复，请先选择原备份核对');
  if(current&&current.phase!=='verified'&&current.environmentDigest!==row.environmentDigest)fail('未完成恢复的目标环境已变化，请先核对原记录');
  if(current&&current.phase!=='verified'&&current.subjectMappingDigest!==row.subjectMappingDigest)fail('未完成恢复的角色映射已变化，请先核对原记录');
  if(current){row.revision=current.revision+1;row.createdAt=current.sourceDigest===row.sourceDigest?current.createdAt:stamp;row.updatedAt=Math.max(current.updatedAt,stamp);}
  return validateResourceRestoreCheckpoint(row);
}
export function advanceResourceCheckpoint(previous,current,phase,stamp){
  validateResourceRestoreCheckpoint(previous);validateResourceRestoreCheckpoint(current);
  if(!same(current,previous))fail('资源恢复记录已变化，请重新核对');
  const order=resourceOrder(previous.kind);if(order.indexOf(phase)!==order.indexOf(previous.phase)+1)fail('资源恢复阶段次序无效');
  return validateResourceRestoreCheckpoint({...current,phase,revision:current.revision+1,updatedAt:Math.max(current.updatedAt,stamp)});
}
