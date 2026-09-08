// On-demand, metadata-only bridge into the global storage card. No media or fee mutation.
const stale=()=>Object.assign(new Error('储存账户或页面已变化，请重新盘点'),{code:'vibe_storage_stale'});
const unavailable=message=>Object.assign(new Error(message),{code:'vibe_storage_unavailable'});
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const account=value=>typeof value==='string'&&/^st-user:.+/.test(value)&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);
export function validateVibeStorageSummary(value,namespace){
  if(value?.version!==1||value.namespace!==namespace||value.status!=='ready')throw unavailable('Vibe 计值归属无效');
  const {assets,previews,records}=value;
  for(const row of [assets,previews,records])if(!row||!integer(row.bytes)||!integer(row.count))throw unavailable('Vibe 占用计值无效');
  if(!integer(assets.originalCount)||!integer(assets.encodingCount)||assets.originalCount+assets.encodingCount!==assets.count||previews.count>assets.count
    ||!integer(records.archivedCount)||!integer(records.pendingCount)||records.archivedCount+records.pendingCount>records.count||!integer(records.reviewCount)
    ||!integer(value.bytes)||value.bytes!==assets.bytes+previews.bytes+records.bytes)throw unavailable('Vibe 占用合计不一致');
  return {version:1,status:'ready',namespace,bytes:value.bytes,
    assets:{bytes:assets.bytes,count:assets.count,originalCount:assets.originalCount,encodingCount:assets.encodingCount},previews:{bytes:previews.bytes,count:previews.count},
    records:{bytes:records.bytes,count:records.count,archivedCount:records.archivedCount,pendingCount:records.pendingCount,reviewCount:records.reviewCount}};
}
export async function collectVibeStorage({resolveNamespace,valid=()=>true,call}={}){
  if(!valid())throw stale();const namespace=await resolveNamespace();if(!valid()||!account(namespace))throw stale();
  const check=async()=>{if(!valid()||namespace!==await resolveNamespace()||!valid())throw stale();};
  let result,error;
  try{
    const invoke=call||(await import('./qianmu-vibe-assets.js')).callVibeAsset;await check();
    result=validateVibeStorageSummary(await invoke('storage-summary',{namespace}),namespace);
  }catch(cause){error=cause;}
  await check();if(error)return {version:1,status:'unavailable',namespace,bytes:null,error:String(error?.message||'Vibe 资料暂不可读取')};return result;
}
