const fail=message=>{throw Object.assign(new Error(message),{code:'storyboard_package_journal',submissionState:'not_submitted'});};
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const VIBE_STAGE_PHASES=Object.freeze(['prepared','staging','assets_ready']);
const key=row=>JSON.stringify([row.namespace,row.chatHash,row.fileHash]);
const fields=['key','version','namespace','sourceNamespace','chatHash','fileHash','fileBytes','assetIds','phase','revision','createdAt','updatedAt'];
export function validateStoryboardPackageCheckpoint(row){
  if(!row||typeof row!=='object'||Object.keys(row).some(name=>!fields.includes(name))||row.version!==1||!account(row.namespace)||!account(row.sourceNamespace)||!hash(row.chatHash)||!hash(row.fileHash)
    ||row.key!==key(row)||!Number.isSafeInteger(row.fileBytes)||row.fileBytes<1||row.fileBytes>128*1024*1024||!Array.isArray(row.assetIds)||row.assetIds.length>1024||row.assetIds.some(id=>!hash(id))||new Set(row.assetIds).size!==row.assetIds.length
    ||!VIBE_STAGE_PHASES.includes(row.phase)||!Number.isSafeInteger(row.revision)||row.revision<1||!Number.isSafeInteger(row.createdAt)||row.createdAt<0||!Number.isSafeInteger(row.updatedAt)||row.updatedAt<row.createdAt)fail('分镜导入恢复记录损坏，请保留原包和本机数据');
  return row;
}
export function prepareVibeStageCheckpoint(descriptor,stamp){
  return structuredClone(validateStoryboardPackageCheckpoint({...descriptor,key:key(descriptor),version:1,phase:'prepared',revision:1,createdAt:stamp,updatedAt:stamp}));
}
export function sameVibeStageDefinition(a,b){
  return ['namespace','sourceNamespace','chatHash','fileHash','fileBytes','assetIds'].every(field=>JSON.stringify(a[field])===JSON.stringify(b[field]));
}
