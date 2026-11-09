// Channel occupancy is not an image/encoding fee receipt. Each operation keeps its own historical ledger.
const HASH=/^[a-f0-9]{64}$/;
const fail=()=>Object.assign(new Error('NAI 共用渠道记录不完整，请先核查原请求'),{code:'image_service_channel_state',status:409,submissionState:'not_submitted'});
export function normalizeNovelServiceChannel(value,channelKey){
  if(!HASH.test(channelKey))throw fail();
  if(value===undefined||value===null)return {schema:'qianmu.novel-occupancy.v1',channelKey,entries:[]};
  if(value.schema!=='qianmu.novel-occupancy.v1'||value.channelKey!==channelKey||!Array.isArray(value.entries)||value.entries.length>1
    ||Object.keys(value).some(key=>!['schema','channelKey','entries'].includes(key)))throw fail();
  const entries=value.entries.map(row=>{
    if(!row||Object.keys(row).some(key=>!['namespace','kind','attemptId','requestDigest','fence','ownerId','status','createdAt','updatedAt'].includes(key))
      ||!['image','vibe'].includes(row.kind)||!['reserved','submitting','uncertain','released'].includes(row.status)||!HASH.test(row.requestDigest))throw fail();
    for(const key of ['namespace','attemptId','fence','ownerId'])if(typeof row[key]!=='string'||!row[key]||row[key].trim()!==row[key]||row[key].length>240||/[\u0000-\u001f\u007f]/.test(row[key]))throw fail();
    if(![row.createdAt,row.updatedAt].every(at=>Number.isSafeInteger(at)&&at>=0)||row.updatedAt<row.createdAt)throw fail();
    return {...row};
  });return {schema:value.schema,channelKey,entries};
}
